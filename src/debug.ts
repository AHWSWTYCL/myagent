/**
 * Headless debug mode for myagent.
 *
 * Usage:
 *   node dist/agent.js --debug "你的提示"
 *   node dist/agent.js --debug --input "你的提示" --auto-yes
 *   node dist/agent.js --debug --input "你的提示" --output result.json
 *
 * stdout → 结构化 JSON（可 pipe 给 jq）
 * stderr → 实时进度（可观察执行状态）
 */

import type { TuiBridge } from './tui/bridge.js'
import type { UsageAccum } from './utils/runagent.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DebugToolCall {
  tool_use_id: string
  name: string
  input: unknown
  output: string
  is_error: boolean
}

export interface DebugTurn {
  role: 'user' | 'assistant'
  content: string
  /**
   * 仅在 assistant 消息中有值。
   * 包含本轮模型发出的所有 tool_use 及其执行结果。
   */
  tool_calls?: DebugToolCall[]
}

export interface HeadlessResult {
  status: 'success' | 'error'
  error?: string
  duration_ms: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  /** 对话消息列表（已清洗为可读格式） */
  messages: DebugTurn[]
}

// ── DebugCollector ────────────────────────────────────────────────────────────

/**
 * 订阅 bridge 事件，收集 token 用量和计时信息。
 * 消息内容本身从 runTurn 执行后的 messages 数组提取，
 * 这里只收集 bridge 事件中额外的元信息。
 */
export class DebugCollector {
  private startedAt = Date.now()
  private _usage: UsageAccum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  private _error: string | null = null

  constructor(bridge: TuiBridge) {
    bridge.on('usage', (stats: UsageAccum) => {
      this._usage = { ...stats }
    })
  }

  get usage(): UsageAccum {
    return { ...this._usage }
  }

  setError(err: string): void {
    this._error = err
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  /**
   * 从 messages 数组构建可读输出。
   *
   * 关键配对逻辑：
   * - assistant 消息中的 tool_use 块和后继 user 消息中的 tool_result 块配对，
   *   将 tool_result 的内容回填到 tool_use 的 output 字段。
   * - tool_result-only 的 user 消息不生成独立的 DebugTurn，避免输出中出现
   *   "(tool results omitted)" 的杂乱消息。
   *
   * @param messages runTurn 执行后的完整对话历史（Anthropic MessageParam[]）
   */
  buildResult(
    messages: Array<{ role: string; content: string | Array<unknown> }>,
    abortReason?: string,
  ): HeadlessResult {
    const result: HeadlessResult = {
      status: this._error ? 'error' : 'success',
      error: this._error ?? undefined,
      duration_ms: this.elapsedMs,
      usage: { ...this._usage },
      messages: [],
    }

    // 存储"待配对"的 assistant turn：该消息有 tool_use 但尚未回填 tool_result
    let pendingAssistant: DebugTurn | null = null

    for (const msg of messages) {
      if (msg.role === 'user') {
        // 判断是否为 tool_result-only 消息（所有顶层 block 都是 tool_result）
        if (this.isToolResultMessage(msg)) {
          // 回填到 pending assistant turn
          if (pendingAssistant) {
            this.pairToolResults(pendingAssistant, msg)
          }
          // 跳过此消息，不生成独立 DebugTurn
          continue
        }

        // 普通 user 消息：清空 pending（之前的 tool_use 没有配对的 tool_result）
        pendingAssistant = null
        result.messages.push(this.toUserTurn(msg))

      } else if (msg.role === 'assistant') {
        const turn = this.toAssistantTurn(msg)
        if (turn.tool_calls && turn.tool_calls.length > 0) {
          pendingAssistant = turn
        } else {
          pendingAssistant = null
        }
        result.messages.push(turn)
      }
    }

    return result
  }

  /** 判断 user 消息是否只包含 tool_result 块（不含 text 用户内容） */
  private isToolResultMessage(msg: { content: string | Array<unknown> }): boolean {
    if (typeof msg.content === 'string') return false
    const blocks = msg.content as Array<Record<string, unknown>>
    return blocks.length > 0 && blocks.every(b => b.type === 'tool_result')
  }

  /**
   * 将 user 消息中的 tool_result 块回填到 assistant turn 的 tool_calls 中。
   * 通过 tool_use_id 匹配，而非索引顺序，防止因 error 工具导致配对错位。
   */
  private pairToolResults(turn: DebugTurn, msg: { content: string | Array<unknown> }): void {
    if (!turn.tool_calls) return
    const blocks = (msg.content as Array<Record<string, unknown>>).filter(b => b.type === 'tool_result')

    // 构建 tool_use_id → tool_call 映射
    const callMap = new Map<string, DebugToolCall>()
    for (const call of turn.tool_calls) {
      if (call.tool_use_id) {
        callMap.set(call.tool_use_id, call)
      }
    }

    // 按 tool_use_id 匹配回填
    for (const block of blocks) {
      const tid = block.tool_use_id as string | undefined
      if (!tid) continue
      const call = callMap.get(tid)
      if (!call) continue

      const resultContent = block.content
      const isError = block.is_error === true

      call.output = this.formatToolResult(resultContent)
      call.is_error = isError
    }
  }

  /** 将 tool_result 的 content 格式化为字符串 */
  private formatToolResult(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((b: Record<string, unknown>) => b.type === 'text')
        .map((b: Record<string, unknown>) => b.text)
        .join('\n')
    }
    return String(content ?? '')
  }

  /** 用户消息是 string 或 ContentBlockParam[]，抽取纯文本 */
  private toUserTurn(msg: { content: string | Array<unknown> }): DebugTurn {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }
    // ContentBlockParam[] — 去除 tool_result 块，只保留 text 块
    const textParts: string[] = []
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
      }
    }
    return { role: 'user', content: textParts.join('\n') || '(tool results omitted)' }
  }

  /** 助手消息：含 text 块和 tool_use 块 */
  private toAssistantTurn(msg: { content: string | Array<unknown> }): DebugTurn {
    if (typeof msg.content === 'string') {
      return { role: 'assistant', content: msg.content }
    }

    const textParts: string[] = []
    const toolCalls: DebugToolCall[] = []

    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        // tool_use 块 — 用占位符，等后续 tool_result 配对
        toolCalls.push({
          tool_use_id: (block.id as string) || '',
          name: block.name as string,
          input: block.input,
          output: '(pending)', // 后续会通过 tool_result 消息补充
          is_error: false,
        })
      }
    }

    const turn: DebugTurn = {
      role: 'assistant',
      content: textParts.join('\n'),
    }
    if (toolCalls.length > 0) {
      turn.tool_calls = toolCalls
    }
    return turn
  }
}

// ── CLI arg parsing ──────────────────────────────────────────────────────────

export interface DebugOptions {
  /** 用户输入的提示 */
  input: string
  /** 是否自动授权 */
  autoYes: boolean
  /** 输出文件路径（可选，默认 stdout） */
  output?: string
  /** 超时秒数（可选，到期自动中断 agent 循环） */
  timeout?: number
  /** 是否恢复上一次 session */
  continue: boolean
}

/**
 * 从 process.argv 解析 debug 模式参数。
 * 如果 --debug 不存在则返回 null。
 *
 * 支持格式：
 *   --debug "prompt"
 *   --debug --input "prompt"
 *   --debug --input "prompt" --auto-yes
 *   --debug --input "prompt" --output /tmp/out.json
 *   -d "prompt"
 *   --continue / -c（debug 模式下恢复会话）
 */
export function parseDebugArgs(): DebugOptions | null {
  const args = process.argv.slice(2)
  const debugIndex = args.findIndex(a => a === '--debug' || a === '-d')
  if (debugIndex === -1) return null

  // 去掉 --debug/-d 本身
  const remaining = [...args]
  remaining.splice(debugIndex, 1)

  const options: DebugOptions = {
    input: '',
    autoYes: false,
    continue: false,
  }

  // 解析标记参数
  for (let i = 0; i < remaining.length; i++) {
    const arg = remaining[i]

    if (arg === '--input' || arg === '-i') {
      options.input = remaining[++i] ?? ''
    } else if (arg === '--auto-yes' || arg === '-y') {
      options.autoYes = true
    } else if (arg === '--output' || arg === '-o') {
      options.output = remaining[++i]
    } else if (arg === '--timeout' || arg === '-t') {
      const val = parseInt(remaining[++i], 10)
      if (isNaN(val) || val <= 0) {
        console.error('[debug] Error: --timeout requires a positive integer (seconds)')
        printHelp()
        process.exit(1)
      }
      options.timeout = val
    } else if (arg === '--continue' || arg === '-c') {
      options.continue = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!arg.startsWith('-') && !options.input) {
      // 裸参数 = 提示词（仅在 --debug 后紧跟的字符串）
      options.input = arg
    }
  }

  if (!options.input) {
    console.error('[debug] Error: --input is required')
    printHelp()
    process.exit(1)
  }

  return options
}

function printHelp(): void {
  console.error(`
Usage:
  node dist/agent.js --debug "your prompt"
  node dist/agent.js --debug --input "your prompt"
  node dist/agent.js -d "prompt" --auto-yes
  node dist/agent.js -d -i "prompt" -o result.json
  node dist/agent.js -c                 # 恢复上一次 session（TUI 模式）
  node dist/agent.js -d -c "继续"       # 恢复上一次 session 并继续对话

Options:
  --debug, -d             启用 headless debug 模式
  --input, -i <text>      要发送的提示文本
  --auto-yes, -y          自动授权所有工具调用
  --output, -o <file>     将 JSON 结果写入文件（默认 stdout）
  --timeout, -t <seconds> 超时自动中断（默认不限时）
  --continue, -c          恢复上一次 session 的对话上下文
  --help, -h              显示帮助

Output (stdout):
  JSON object with status, duration_ms, usage, and messages[]
`)
}

// ── stderr progress logging ──────────────────────────────────────────────────

/**
 * 进度日志：写 stderr，不污染 stdout 的 JSON 输出。
 */
export const logProgress = {
  start(msg: string) {
    console.error(`⏺ ${msg}`)
  },
  ok(msg: string) {
    console.error(`  ✓ ${msg}`)
  },
  toolStart(name: string, args: string) {
    console.error(`  ⏺ ${name}(${args})`)
  },
  toolEnd(name: string, args: string, ok: boolean) {
    console.error(`  ${ok ? '✓' : '✗'} ${name}(${args})`)
  },
  error(msg: string) {
    console.error(`  ❌ ${msg}`)
  },
}
