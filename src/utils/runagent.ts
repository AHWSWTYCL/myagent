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
  /**
   * 消息队列 drain 回调：每轮工具执行之后调用，返回下一条用户消息（无消息则返回 undefined）。
   * 返回的消息会追加到 messages 数组，让下一轮 LLM 调用看到新输入。
   *
   * 两个调用点：
   *   (1) 工具执行完成 + onTurnEnd 之后，下一轮 LLM 之前
   *   (2) end_turn/stop 之前（如有排队消息则不 break 而 continue）
   */
  drainQueue?: () => string | undefined
  /**
   * Attachment 队列 drain 回调：每轮工具执行之后调用。
   * 将系统状态变更（任务/技能/Agent 等）格式化为文本注入 LLM 上下文。
   * 返回非空字符串时会以 [System State Changes] 格式推入 messages[]。
   *
   * 调用点：与 drainQueue 相同
   */
  drainAttachments?: () => string
  /**
   * Leader 邮箱 drain 回调：每轮工具执行之后调用。
   * 扫描主 agent 邮箱中的未读邮件（teammate 发来的 result/status 等），
   * 格式化为文本注入 LLM 上下文。
   * 返回非空字符串时推入 messages[]。
   *
   * 调用点：与 drainQueue 相同
   */
  drainMailbox?: () => string | undefined
  /**
   * 后台信号：当此 signal 触发时（aborted），当前 loop 执行 handoff：
   * fork messages、收尾、返回 backgrounded=true。
   * 与 signal（中断信号）互相独立，可同时存在。
   */
  backgroundSignal?: AbortSignal

  /**
   * 长期存活模式：当 stop_reason != 'tool_use' 且所有 drain 返回空时，
   * 不 break，而是调用 waitForEvent 挂起等待新事件。
   * 适用场景：teammate worker 需要长期轮询邮箱等待用户/leader 消息。
   */
  keepAlive?: boolean
  /**
   * keepAlive 模式下的事件等待回调。返回非空字符串时注入 messages 并 continue；
   * 返回 undefined 时 break 退出（收到 close 或 signal abort）。
   */
  waitForEvent?: () => Promise<string | undefined>

  /**
   * 每次 LLM API 调用前触发（仅观察，不阻断）。
   * 用于 TranscriptRecorder 记录 llm_request 事件。
   * turn 从 0 开始计，每轮递增。
   */
  onLLMRequest?: (model: string, turn: number, messages: Anthropic.MessageParam[]) => void
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

/** 后台 handoff 的 fork 状态 */
export interface BackgroundFork {
  messages: Anthropic.MessageParam[]
  usage: UsageAccum
}

/** runAgentLoopStream 的返回结果 */
export interface RunAgentLoopResult {
  messages: Anthropic.MessageParam[]
  backgrounded: boolean
  fork?: BackgroundFork
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
): Promise<RunAgentLoopResult> {
  const {
    client, model, system, tools, messages, maxTurns = 20,
    executeTool, onText, onTurnEnd, onToolStart, onToolEnd, onUsage, signal, parallelSafeTools,
    onTurnToolReset, drainQueue, drainAttachments, drainMailbox, backgroundSignal,
    keepAlive, waitForEvent, onLLMRequest,
  } = opts

  // input / cacheRead / cacheWrite are PER-REQUEST snapshots (the API already counts
  // the full conversation each turn — accumulating across turns would inflate the
  // count and prematurely trip the compact threshold). outputTokens stays accumulated
  // because each turn produces fresh tokens.
  const cumUsage: UsageAccum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const MAX_TOKENS_RECOVERY_LIMIT = 3
  let maxTokensRecoveryCount = 0

  /**
   * 检查后台信号是否触发。如果是，fork 当前状态、执行收尾、返回 handoff 结果。
   * 返回 null 表示无后台信号，继续正常执行。
   */
  function doBackgroundHandoff(currentTurnText: string): RunAgentLoopResult | null {
    if (!backgroundSignal?.aborted) return null
    const forkedMessages = messages.slice()
    const forkedUsage: UsageAccum = { ...cumUsage }
    // Fire onTurnEnd once (partial turn text) so the TUI archives whatever was streamed
    // Note: we call onTurnToolReset here so the last round's tools get archived
    if (currentTurnText) {
      // 异步但 fire-and-forget — 我们不 await 因为正在退出
      onTurnEnd?.(currentTurnText, messages)?.catch(() => {})
    }
    onTurnToolReset?.()
    process.stderr.write(`[queryLoop] background handoff at turn (forked ${forkedMessages.length} messages)\n`)
    return { messages, backgrounded: true, fork: { messages: forkedMessages, usage: forkedUsage } }
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      process.stderr.write(`[queryLoop] exit: aborted before turn ${turn}\n`)
      break
    }
    // Check background signal at start of each turn
    const bgHandoff = doBackgroundHandoff('')
    if (bgHandoff) return bgHandoff

    const systemParam = await resolveSystem(system)
    onLLMRequest?.(model, turn, messages)
    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      tools,
      messages,
      system: systemParam,
    })

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
    } catch (err) {
      // MessageStream 的 asyncIterator 在 abort 时会 reject 所有 pending read。
      // 捕获异常并将 streamAborted 置 true，走 abort 清理路径而非向上抛。
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[queryLoop] stream error at turn ${turn}: ${msg}\n`)
      if (err instanceof Anthropic.APIError) {
        process.stderr.write(`[queryLoop] API error status=${err.status} type=${err.type}\n`)
      }
      streamAborted = true
    }

    if (onUsage) onUsage({ ...cumUsage })

    if (streamAborted || signal?.aborted) {
      process.stderr.write(`[queryLoop] exit: aborted during stream at turn ${turn}\n`)
      break
    }
    // Background check after streaming
    {
      const bg = doBackgroundHandoff(turnText)
      if (bg) return bg
    }

    let response: Anthropic.Message
    try {
      response = await stream.finalMessage()
    } catch (err) {
      process.stderr.write(`[queryLoop] exit: stream.finalMessage failed at turn ${turn}: ${err}\n`)
      break
    }
    messages.push({ role: 'assistant', content: response.content })

    const isToolUse = response.stop_reason === 'tool_use'

    if (!isToolUse) {
      // ── end_turn / stop_sequence / max_tokens ──────────────────────
      if (turnText) await onTurnEnd?.(turnText, messages)
      {
        const bg = doBackgroundHandoff('')
        if (bg) return bg
      }
      if (response.stop_reason === 'max_tokens') {
        if (maxTokensRecoveryCount >= MAX_TOKENS_RECOVERY_LIMIT) {
          process.stderr.write(`[queryLoop] exit at turn ${turn}: max_tokens recovery limit reached\n`)
          break
        }
        maxTokensRecoveryCount++
        process.stderr.write(`[queryLoop] turn ${turn}: max_tokens hit (recovery ${maxTokensRecoveryCount}/${MAX_TOKENS_RECOVERY_LIMIT}), continuing...\n`)
        messages.push({ role: 'user', content: 'Output token limit hit. Resume your response directly from where you left off, without repeating anything.' })
        continue
      }
      maxTokensRecoveryCount = 0
      // 不 break — 先走统一 drain，有内容则 continue，无内容才 break
    } else {
      // ── tool_use ───────────────────────────────────────────────────
      maxTokensRecoveryCount = 0
      const rawBlocks = response.content.filter(b => b && b.type === 'tool_use')
      const toolBlocks = rawBlocks as Anthropic.ToolUseBlock[]
      const toolResults = await executeToolsWithParallelism(toolBlocks, executeTool, onToolStart, onToolEnd, parallelSafeTools, onTurnToolReset)
      messages.push({ role: 'user', content: toolResults })

      if (turnText) await onTurnEnd?.(turnText, messages)

      {
        const bg = doBackgroundHandoff('')
        if (bg) return bg
      }
    }

    // ── 统一 DRAIN（每次 LLM 调用结束后都执行）──────────────────────
    // 放在 for 循环底部，tool_use / end_turn 都会走到这里。
    // drain 到任何内容 → push 到 messages → continue 下一轮 LLM 及时处理
    if (drainQueue) {
      const nextMsg = drainQueue()
      if (nextMsg) {
        messages.push({ role: 'user', content: nextMsg })
        continue
      }
    }
    if (drainAttachments) {
      const attText = drainAttachments()
      if (attText) {
        messages.push({ role: 'user', content: attText })
        continue
      }
    }
    if (drainMailbox) {
      const mailText = drainMailbox()
      if (mailText) {
        messages.push({ role: 'user', content: mailText })
        continue
      }
    }

    // 无 drain 内容
    if (!isToolUse) {
      // ── keepAlive：长期存活 worker 不退出，等待异步事件 ──────────
      if (keepAlive && waitForEvent && !signal?.aborted) {
        process.stderr.write(`[queryLoop] turn ${turn}: keepAlive — waiting for event...\n`)
        const eventText = await waitForEvent()
        if (eventText) {
          messages.push({ role: 'user', content: eventText })
          continue
        }
        process.stderr.write(`[queryLoop] exit at turn ${turn}: keepAlive — no more events\n`)
      }

      if (response.stop_reason !== 'end_turn') {
        process.stderr.write(`[queryLoop] exit at turn ${turn}: stop_reason=${response.stop_reason}\n`)
      }
      break
    }

    if (turn === maxTurns - 1) {
      process.stderr.write(`[queryLoop] exit: hit maxTurns=${maxTurns} (model still wanted to call tools)\n`)
    }
  }

  // 所有 LLM round 结束后，触发最后一次 turnToolReset，归档最后一轮的
  // 探索工具（read_file/list_dir/glob/grep）到摘要消息中。
  // 否则单 round 场景（所有工具在一个 LLM round 内完成）下，
  // onTurnToolReset 永远等不到下一轮来触发，工具会留在 turnTools 中
  // 只在底部动态区显示，不会进入聊天历史。
  onTurnToolReset?.()

  return { messages, backgrounded: false }
}
