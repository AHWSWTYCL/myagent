import Anthropic from '@anthropic-ai/sdk'
import { withRetry } from '../client.js'

export interface RunAgentOptions {
  client: Anthropic
  model: string
  /**
   * System prompt. Three forms accepted:
   *   1. static string — wrapped as a single TextBlockParam with ephemeral cache_control
   *   2. () => string — same as above, re-evaluated each turn
   *   3. () => TextBlockParam[] — caller decides cache_control per segment.
   *      Use this to split the system prompt into stable (cached) + dynamic (uncached) parts
   *      so prompt cache stays warm even when only the dynamic part changes.
   */
  system:
    | string
    | (() => string | Anthropic.TextBlockParam[] | Promise<string | Anthropic.TextBlockParam[]>)
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  maxTurns?: number
  executeTool: (name: string, input: unknown) => Promise<string>
  /** Names of tools that are safe to execute concurrently (no side effects, no permission prompts). */
  parallelSafeTools?: Set<string>
  /**
   * Called before each LLM round's tool execution batch, so the UI can
   * archive the previous round's completed exploration tools as per-round
   * TurnSummary static messages (Scenario B).
   */
  onTurnToolReset?: () => void
}

async function resolveSystem(
  system: RunAgentOptions['system'],
): Promise<Anthropic.TextBlockParam[]> {
  const value = typeof system === 'function' ? await system() : system
  if (typeof value === 'string') {
    // Default: cache the whole thing (caller didn't bother to split).
    return [{ type: 'text', text: value, cache_control: { type: 'ephemeral' } }]
  }
  return value
}

export interface UsageAccum {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

async function executeToolsWithParallelism(
  blocks: Anthropic.ToolUseBlock[],
  executeTool: (name: string, input: unknown) => Promise<string>,
  onToolStart?: (callId: string, name: string, input: unknown) => void,
  onToolEnd?: (callId: string, name: string, input: unknown, output: string) => void,
  parallelSafeTools: Set<string> = new Set(),
  onTurnToolReset?: () => void,
): Promise<Anthropic.ToolResultBlockParam[]> {
  // Partition into groups that can run in parallel vs must run serially.
  // We preserve the original order in the result array regardless.
  type Entry = { block: Anthropic.ToolUseBlock; index: number }
  const parallel: Entry[] = []
  const serial: Entry[] = []

  blocks.forEach((block, index) => {
    if (parallelSafeTools.has(block.name)) {
      parallel.push({ block, index })
    } else {
      serial.push({ block, index })
    }
  })

  // onTurnToolReset fires here so the TUI can archive the previous round's
  // exploration tools as TurnSummary static messages per-round (Scenario B).
  onTurnToolReset?.()

  // Emit toolStart in the ORIGINAL LLM call order, not the partitioned order.
  // Otherwise the TUI's turnTools array would sort all parallel-safe tools
  // (read_file/grep/glob/list_dir) before serial tools (bash/edit_file/etc),
  // causing the TurnSummary to always appear at the top and potentially
  // merging same-name serial tools that the LLM intended to be separated by
  // exploration tools in between.
  for (const block of blocks) {
    if (!block) continue
    onToolStart?.(block.id, block.name, block.input)
  }

  const results: Anthropic.ToolResultBlockParam[] = new Array(blocks.length)

  // Run parallel-safe tools concurrently.
  await Promise.all(
    parallel.map(async ({ block, index }) => {
      if (!block) return
      const result = await executeTool(block.name, block.input)
      onToolEnd?.(block.id, block.name, block.input, result)
      results[index] = { type: 'tool_result', tool_use_id: block.id, content: result }
    }),
  )

  // Run serial tools one at a time (preserving order).
  for (const { block, index } of serial) {
    if (!block) continue
    const result = await executeTool(block.name, block.input)
    onToolEnd?.(block.id, block.name, block.input, result)
    results[index] = { type: 'tool_result', tool_use_id: block.id, content: result }
  }

  return results
}

export async function runAgentLoopStream(
  opts: RunAgentOptions & {
    onText?: (delta: string) => void
    onTurnEnd?: (text: string, messages: Anthropic.MessageParam[]) => void | Promise<void>
    onToolStart?: (callId: string, name: string, input: unknown) => void
    onToolEnd?: (callId: string, name: string, input: unknown, output: string) => void
    onUsage?: (usage: UsageAccum) => void
    signal?: AbortSignal
  },
): Promise<Anthropic.MessageParam[]> {
  const {
    client, model, system, tools, messages, maxTurns = 20,
    executeTool, onText, onTurnEnd, onToolStart, onToolEnd, onUsage, signal, parallelSafeTools,
    onTurnToolReset,
  } = opts

  // input / cacheRead / cacheWrite are PER-REQUEST snapshots (the API already counts
  // the full conversation each turn — accumulating across turns would inflate the
  // count and prematurely trip the compact threshold). outputTokens stays accumulated
  // because each turn produces fresh tokens.
  const cumUsage: UsageAccum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const MAX_TOKENS_RECOVERY_LIMIT = 3
  let maxTokensRecoveryCount = 0

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      console.log(`[queryLoop] exit: aborted before turn ${turn}`)
      break
    }

    const systemParam = await resolveSystem(system)
    const stream = await withRetry(() => client.messages.stream({
      model,
      max_tokens: 8192,
      tools,
      messages,
      system: systemParam,
    }))

    signal?.addEventListener('abort', () => stream.abort(), { once: true })

    let turnText = ''
    let streamAborted = false
    try {
      for await (const event of stream) {
        if (signal?.aborted) { streamAborted = true; break }
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          turnText += event.delta.text
          onText?.(event.delta.text)
        }
        // input/cache numbers represent the full prompt the API saw THIS turn —
        // overwrite, don't accumulate. Output tokens are net-new and accumulate.
        if (event.type === 'message_start') {
          const u = event.message.usage
          cumUsage.inputTokens = u.input_tokens ?? 0
          cumUsage.cacheReadTokens = u.cache_read_input_tokens ?? 0
          cumUsage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0
        }
        if (event.type === 'message_delta') {
          cumUsage.outputTokens += event.usage.output_tokens
        }
      }
    } catch (_err) {
      // MessageStream 的 asyncIterator 在 abort 时会 reject 所有 pending read。
      // 捕获异常并将 streamAborted 置 true，走 abort 清理路径而非向上抛。
      streamAborted = true
    }

    if (onUsage) onUsage({ ...cumUsage })

    if (streamAborted || signal?.aborted) {
      console.log(`[queryLoop] exit: aborted during stream at turn ${turn}`)
      break
    }

    let response: Anthropic.Message
    try {
      response = await stream.finalMessage()
    } catch (err) {
      console.error(`[queryLoop] exit: stream.finalMessage failed at turn ${turn}:`, err)
      break
    }
    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      // Fire onTurnEnd after the assistant message is in the history, so hooks
      // observe a consistent snapshot. Awaited so per-turn side effects (memory
      // extract scheduling, retrospective counting) run before the next iteration.
      if (turnText) await onTurnEnd?.(turnText, messages)
      if (response.stop_reason === 'max_tokens') {
        if (maxTokensRecoveryCount >= MAX_TOKENS_RECOVERY_LIMIT) {
          console.log(`[queryLoop] exit at turn ${turn}: max_tokens recovery limit reached`)
          break
        }
        maxTokensRecoveryCount++
        console.log(`[queryLoop] turn ${turn}: max_tokens hit (recovery ${maxTokensRecoveryCount}/${MAX_TOKENS_RECOVERY_LIMIT}), continuing...`)
        // Inject a continuation prompt so the model knows to resume rather than restart
        messages.push({ role: 'user', content: 'Output token limit hit. Resume your response directly from where you left off, without repeating anything.' })
        continue
      }
      maxTokensRecoveryCount = 0
      if (response.stop_reason !== 'end_turn') {
        console.log(`[queryLoop] exit at turn ${turn}: stop_reason=${response.stop_reason}`)
      }
      break
    }
    maxTokensRecoveryCount = 0

    // Filter out any undefined entries from the API response content array
    const rawBlocks = response.content.filter(b => b && b.type === 'tool_use')
    const toolBlocks = rawBlocks as Anthropic.ToolUseBlock[]
    const toolResults = await executeToolsWithParallelism(toolBlocks, executeTool, onToolStart, onToolEnd, parallelSafeTools, onTurnToolReset)
    messages.push({ role: 'user', content: toolResults })

    // Fire onTurnEnd AFTER tools execute so the TUI shows tools before the
    // assistant's summary text (Claude Code display order: tools first, text last).
    if (turnText) await onTurnEnd?.(turnText, messages)

    if (turn === maxTurns - 1) {
      console.log(`[queryLoop] exit: hit maxTurns=${maxTurns} (model still wanted to call tools)`)
    }
  }

  // 所有 LLM round 结束后，触发最后一次 turnToolReset，归档最后一轮的
  // 探索工具（read_file/list_dir/glob/grep）到摘要消息中。
  // 否则单 round 场景（所有工具在一个 LLM round 内完成）下，
  // onTurnToolReset 永远等不到下一轮来触发，工具会留在 turnTools 中
  // 只在底部动态区显示，不会进入聊天历史。
  onTurnToolReset?.()

  return messages
}
