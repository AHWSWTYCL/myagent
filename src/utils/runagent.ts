import Anthropic from '@anthropic-ai/sdk'
import { withRetry } from '../client.js'

export interface RunAgentOptions {
  client: Anthropic
  model: string
  /**
   * System prompt. Either a static string, or a function that's re-evaluated at the start
   * of every inner loop iteration (so memory recall / dynamic context can run per-turn,
   * matching Claude Code's queryLoop semantics).
   */
  system: string | (() => string | Promise<string>)
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  maxTurns?: number
  executeTool: (name: string, input: unknown) => Promise<string>
  /** Names of tools that are safe to execute concurrently (no side effects, no permission prompts). */
  parallelSafeTools?: Set<string>
}

async function resolveSystem(system: RunAgentOptions['system']): Promise<string> {
  return typeof system === 'function' ? await system() : system
}

export interface UsageAccum {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export async function runAgentLoop(opts: RunAgentOptions): Promise<Anthropic.MessageParam[]> {
  const { client, model, system, tools, messages, maxTurns = 20, executeTool, parallelSafeTools } = opts

  for (let turn = 0; turn < maxTurns; turn++) {
    const resolvedSystem = await resolveSystem(system)
    const response = await withRetry(() => client.messages.create({
      model,
      max_tokens: 4096,
      tools,
      messages,
      system: resolvedSystem,
    }))
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') break

    const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
    const toolResults = await executeToolsWithParallelism(toolBlocks, executeTool, undefined, parallelSafeTools)
    messages.push({ role: 'user', content: toolResults })
  }

  return messages
}

async function executeToolsWithParallelism(
  blocks: Anthropic.ToolUseBlock[],
  executeTool: (name: string, input: unknown) => Promise<string>,
  onToolStart?: (name: string, input: unknown) => void,
  parallelSafeTools: Set<string> = new Set(),
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

  const results: Anthropic.ToolResultBlockParam[] = new Array(blocks.length)

  // Run parallel-safe tools concurrently.
  await Promise.all(
    parallel.map(async ({ block, index }) => {
      onToolStart?.(block.name, block.input)
      const result = await executeTool(block.name, block.input)
      results[index] = { type: 'tool_result', tool_use_id: block.id, content: result }
    }),
  )

  // Run serial tools one at a time (preserving order).
  for (const { block, index } of serial) {
    onToolStart?.(block.name, block.input)
    const result = await executeTool(block.name, block.input)
    results[index] = { type: 'tool_result', tool_use_id: block.id, content: result }
  }

  return results
}

export async function runAgentLoopStream(
  opts: RunAgentOptions & {
    onText?: (delta: string) => void
    onTurnEnd?: (text: string, messages: Anthropic.MessageParam[]) => void | Promise<void>
    onToolStart?: (name: string, input: unknown) => void
    onUsage?: (usage: UsageAccum) => void
    signal?: AbortSignal
  },
): Promise<Anthropic.MessageParam[]> {
  const {
    client, model, system, tools, messages, maxTurns = 20,
    executeTool, onText, onTurnEnd, onToolStart, onUsage, signal, parallelSafeTools,
  } = opts

  const cumUsage: UsageAccum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) break

    const resolvedSystem = await resolveSystem(system)
    const stream = await withRetry(() => client.messages.stream({
      model,
      max_tokens: 4096,
      tools,
      messages,
      system: resolvedSystem,
    }))

    signal?.addEventListener('abort', () => stream.abort(), { once: true })

    let turnText = ''
    for await (const event of stream) {
      if (signal?.aborted) break
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        turnText += event.delta.text
        onText?.(event.delta.text)
      }
      // Accumulate usage from message_start (input) and message_delta (output)
      if (event.type === 'message_start') {
        const u = event.message.usage
        cumUsage.inputTokens += u.input_tokens ?? 0
        cumUsage.cacheReadTokens += u.cache_read_input_tokens ?? 0
        cumUsage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0
      }
      if (event.type === 'message_delta') {
        cumUsage.outputTokens += event.usage.output_tokens
      }
    }

    if (onUsage) onUsage({ ...cumUsage })

    if (signal?.aborted) break

    let response: Anthropic.Message
    try {
      response = await stream.finalMessage()
    } catch {
      break
    }
    messages.push({ role: 'assistant', content: response.content })

    // Fire onTurnEnd after the assistant message is in the history, so hooks
    // observe a consistent snapshot. Awaited so per-turn side effects (memory
    // extract scheduling, retrospective counting) run before the next iteration.
    if (turnText) await onTurnEnd?.(turnText, messages)

    if (response.stop_reason !== 'tool_use') break

    const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
    const toolResults = await executeToolsWithParallelism(toolBlocks, executeTool, onToolStart, parallelSafeTools)
    messages.push({ role: 'user', content: toolResults })
  }

  return messages
}
