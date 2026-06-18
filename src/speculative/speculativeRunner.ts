import Anthropic from '@anthropic-ai/sdk'
import { runAgentLoopStream } from '../utils/runagent.js'
import { createClient } from '../client.js'
import { modelConfig } from '../llm/model-config.js'
import { sessionState } from '../state/sessionState.js'
import { ToolRegistrar } from '../tools/toolregistrar.js'
import type { Tool } from '../tools/tool.js'
import { FileOverlay } from './fileOverlay.js'

// ── 工具分类（对齐 Claude Code 的 WRITE_TOOLS / SAFE_READ_ONLY_TOOLS） ──

const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file'])
const READ_ONLY_TOOL_NAMES = new Set(['read_file', 'list_dir', 'glob', 'grep'])
const SAFE_BASH_PATTERNS = /^(ls|cat|head|tail|wc|git\s+(status|diff|log|show|branch|tag|stash\s+list)|pwd|which|type|date|whoami|uname|node\s+(-v|--version)|npm\s+(list|ls|view|info|outdated)|npx\s+--version|tree)\b/

export interface CompletionBoundary {
  type: 'complete' | 'incomplete'
  completedAt: number
  turnText: string
}

export interface SpeculationResult {
  messages: Anthropic.MessageParam[]
  boundary: CompletionBoundary | null
  /** 投机执行节省的时间（ms）：boundary.completedAt - startTime */
  timeSavedMs: number
  /**
   * messages 中是否已包含用户输入（ghostText）。
   * complete=true 时 messages 是完整的（含 user message），调用方直接 replace 即可。
   * complete=false 时 messages 已去掉 ghostText user message，调用方正常 enqueue 用户输入即可。
   */
  includesUserMessage: boolean
}

export type SpeculativeState =
  | { kind: 'idle' }
  | {
      kind: 'running'
      abortController: AbortController
      /** Mutable ref — 参考 Claude Code 的 messagesRef，避免每次 append 都深拷贝 */
      messagesRef: { current: Anthropic.MessageParam[] }
      overlay: FileOverlay
      startTime: number
      boundary: CompletionBoundary | null
      /** ghostText user message 在 messagesRef.current 中的索引。accept incomplete 时用于精确删除 */
      ghostTextIndex: number
    }
  | { kind: 'done'; result: SpeculationResult; overlay: FileOverlay }
  | { kind: 'aborted'; reason: string }

/** canUseTool 回调的返回值 */
export interface CanUseToolResult {
  allowed: boolean
  /** 可选：重写后的工具输入（用于路径 overlay 重定向） */
  rewrittenInput?: Record<string, unknown>
  /** 可选：拒绝原因 */
  reason?: string
}

export interface SpeculativeStartOptions {
  /** 工具映射表（name → Tool 实例） */
  tools: Map<string, Tool>
  /** 构建 system prompt segments */
  buildSystemSegments: () => Anthropic.TextBlockParam[]
  /**
   * 动态工具权限检查（参考 Claude Code 的 canUseTool）。
   * 若不传，默认只允许 READ_ONLY_TOOL_NAMES。
   * 返回 CanUseToolResult 可控制是否允许 + 是否重写输入。
   */
  canUseTool?: (toolName: string, input: Record<string, unknown>, isWrite: boolean) => Promise<CanUseToolResult>
}

/**
 * SpeculativeRunner — 投机执行调度器（对齐 Claude Code 设计）。
 *
 * ## 与 Claude Code 的对齐点
 *
 * 1. **Copy-on-Write Overlay**: Write/Edit 写入临时目录，accept 后复制回 cwd
 * 2. **Mutable messagesRef**: 用 `{ current: Message[] }` 避免每轮深拷贝
 * 3. **CompletionBoundary**: 追踪首个完整 assistant response，精确计算 timeSavedMs
 * 4. **canUseTool 回调**: 动态权限 + 路径重写，替代静态白名单
 * 5. **AbortController 层级**: 支持父级 abort 信号级联
 */
export class SpeculativeRunner {
  private _state: SpeculativeState = { kind: 'idle' }
  private _runPromise: Promise<void> | null = null

  get state(): SpeculativeState { return this._state }
  get isRunning(): boolean { return this._state.kind === 'running' }
  get isDone(): boolean { return this._state.kind === 'done' }

  /**
   * 启动投机执行。
   */
  async startSpeculation(suggestion: string, opts: SpeculativeStartOptions): Promise<void> {
    // 只在主 agent idle 时启动
    if (sessionState.agentRunning) return

    this.discardSilent()

    const overlay = new FileOverlay(process.cwd())
    const abortController = new AbortController()

    // Mutable ref — 参考 Claude Code，避免深拷贝扩散
    const messagesRef: { current: Anthropic.MessageParam[] } = {
      current: [
        ...sessionState.messages,
        { role: 'user' as const, content: suggestion },
      ],
    }

    const startTime = Date.now()
    let boundary: CompletionBoundary | null = null

    this._state = {
      kind: 'running',
      abortController,
      messagesRef,
      overlay,
      startTime,
      boundary: null,
      ghostTextIndex: sessionState.messages.length,  // ghostText 紧跟在原始 messages 之后
    }

    const client = createClient()
    const model = modelConfig.getCurrent()

    // 构建工具子集：read_only + write（由 canUseTool 控制）
    const allowedTools = new ToolRegistrar()
    const allToolNames = new Set([
      ...READ_ONLY_TOOL_NAMES,
      ...WRITE_TOOL_NAMES,
    ])
    for (const toolName of allToolNames) {
      const tool = opts.tools.get(toolName)
      if (tool) allowedTools.registerTool(tool)
    }

    // 先 await overlay.init()，确保目录就绪后再启动 agent loop。
    // 否则 LLM 第一轮快速返回 write 工具时，overlay 目录可能还没建好。
    const initOk = await overlay.init()
    if (!initOk || this._state.kind !== 'running' || this._state.overlay !== overlay) {
      // init 失败 / 被 preempt（另一个 startSpeculation 创建了新的 running 状态）
      if (this._state.kind === 'running' && this._state.overlay === overlay) this.reset()
      else overlay.discard().catch(() => {})  // 被 preempt，旧 overlay 没人管了
      return
    }

    this._runPromise = runAgentLoopStream({
      client,
      model,
      system: opts.buildSystemSegments,
      tools: allowedTools.getAllTools(),
      messages: messagesRef.current,
      maxTurns: 10,
      signal: abortController.signal,
      executeTool: async (name, input): Promise<string> => {
        // canUseTool 检查
        const isWrite = WRITE_TOOL_NAMES.has(name)
        const toolInput = input as Record<string, unknown>

        if (opts.canUseTool) {
          const decision = await opts.canUseTool(name, toolInput, isWrite)
          if (!decision.allowed) {
            return `Error: Tool "${name}" not allowed in speculation: ${decision.reason ?? 'denied'}`
          }
          if (decision.rewrittenInput) {
            input = decision.rewrittenInput
          }
        } else {
          // 默认策略：只允许 read_only
          if (!READ_ONLY_TOOL_NAMES.has(name)) {
            return `Error: Tool "${name}" not allowed in speculation (read-only mode)`
          }
        }

        const tool = allowedTools.getTool(name)
        if (!tool) return `Unknown tool: ${name}`
        try {
          return await tool.execute(input as Record<string, unknown>, abortController.signal)
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    })
      .then(result => {
        if (this._state.kind !== 'running') return

        // 记录 CompletionBoundary（投机执行完成）
        boundary = {
          type: 'complete',
          completedAt: Date.now(),
          turnText: '',
        }

        this._state = {
          kind: 'done',
          result: {
            messages: result.messages,
            boundary,
            timeSavedMs: boundary.completedAt - startTime,
            includesUserMessage: true,
          },
          overlay,
        }
      })
      .catch(err => {
        if (this._state.kind !== 'running') return

        // 先拿 overlay 引用，清理后再改 state（aborted 状态无 overlay 字段）
        const errOverlay = this._state.overlay

        if (err instanceof Error && err.name === 'AbortError') {
          // 被用户中断 — 记录部分 boundary
          boundary = {
            type: 'incomplete',
            completedAt: Date.now(),
            turnText: '',
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`[speculative] error: ${msg}\n`)
        }
        this._state = {
          kind: 'aborted',
          reason: err instanceof Error ? err.message : String(err),
        }
        errOverlay.discard().catch(() => {})
      })
  }

  /** 默认 canUseTool 实现：读工具直接放行，写工具用 overlay 重写路径 */
  async defaultCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    isWrite: boolean,
  ): Promise<CanUseToolResult> {
    if (READ_ONLY_TOOL_NAMES.has(toolName)) {
      // Read 工具：若文件已被 overlay 写过，重定向到 overlay
      if (this._state.kind === 'running') {
        const rewritten = await this._state.overlay.rewritePath(input, false)
        return { allowed: true, rewrittenInput: rewritten }
      }
      return { allowed: true }
    }

    if (WRITE_TOOL_NAMES.has(toolName)) {
      // Write 工具只在 running 状态下通过 overlay 放行
      if (this._state.kind !== 'running') {
        return { allowed: false, reason: 'write tool called outside running state' }
      }
      const rewritten = await this._state.overlay.rewritePath(input, true)
      return { allowed: true, rewrittenInput: rewritten }
    }

    if (toolName === 'bash') {
      const command = typeof input.command === 'string' ? input.command : ''
      if (!command || command.trim().length === 0) {
        return { allowed: false, reason: 'empty bash command' }
      }
      if (SAFE_BASH_PATTERNS.test(command.trim())) {
        return { allowed: true }
      }
      return { allowed: false, reason: `bash command not in safe list: ${command.slice(0, 80)}` }
    }

    return { allowed: false, reason: `tool not allowed: ${toolName}` }
  }

  /**
   * 用户接受建议：abort sub-agent，返回 speculative 结果。
   *
   * 参考 Claude Code 的 acceptSpeculation：
   * 1. abort + 复制 overlay → cwd
   * 2. 返回 { messages, boundary, timeSavedMs }
   */
  async accept(): Promise<SpeculationResult | null> {
    if (this._state.kind === 'idle') return null
    if (this._state.kind === 'aborted') {
      this.reset()
      return null
    }

    // 在 abort 前先捕获结果（避免 abort 后 state 被 .catch 改变）
    let result: SpeculationResult | null = null

    if (this._state.kind === 'done') {
      result = this._state.result
    } else if (this._state.kind === 'running') {
      // 未完成：去掉 ghostText user message，并裁剪末尾使主 agent 可续接。
      //
      // 主 agent 的 runTurn 总会在 messages 末尾追加 {role:'user'}，
      // 所以 cleanMessages 末尾必须是 {role:'assistant'}（否则连续两个 user 会 API 错误）。
      // 对齐 Claude Code: 裁剪末尾的非 assistant 消息配对。
      const { messagesRef, ghostTextIndex } = this._state
      let cleanMessages = [
        ...messagesRef.current.slice(0, ghostTextIndex),
        ...messagesRef.current.slice(ghostTextIndex + 1),
      ]

      // 确保末尾是 assistant（裁剪末尾的 user+assistant 配对）
      while (cleanMessages.length > 0 && cleanMessages[cleanMessages.length - 1]!.role !== 'assistant') {
        cleanMessages.pop()
      }
      // 如果全部被裁剪了，回退到原始 sessionState（安全底线）
      if (cleanMessages.length === 0) {
        cleanMessages = messagesRef.current.slice(0, ghostTextIndex)
      }

      const boundary: CompletionBoundary = {
        type: 'incomplete',
        completedAt: Date.now(),
        turnText: '',
      }
      result = {
        messages: cleanMessages,
        boundary,
        timeSavedMs: boundary.completedAt - this._state.startTime,
        includesUserMessage: false,
      }
    }

    // 提取 overlay 引用（before abort 会改变 state）
    const overlay = this._state.kind === 'running' ? this._state.overlay
      : this._state.kind === 'done' ? this._state.overlay
      : null

    // 先停止 sub-agent，防止 accept 期间仍在写入 overlay 导致文件撕裂
    if (this._state.kind === 'running') {
      this._state.abortController.abort()
      await this._runPromise?.catch(() => {})
    }

    // sub-agent 完全停止后，再 copy overlay → cwd
    if (overlay) await overlay.accept().catch(() => {})

    this.reset()
    return result
  }

  /** 用户自己输入：abort + 丢弃 overlay */
  async discard(): Promise<void> {
    if (this._state.kind === 'idle') return

    const overlay = this._state.kind === 'running' ? this._state.overlay
      : this._state.kind === 'done' ? this._state.overlay
      : null

    if (this._state.kind === 'running') {
      this._state.abortController.abort()
      await this._runPromise?.catch(() => {})
    }

    if (overlay) await overlay.discard().catch(() => {})

    this.reset()
  }

  /** 静默丢弃（fire-and-forget）。先捕获引用再 reset，防止 reset 后引用丢失。 */
  private discardSilent(): void {
    // 提取需要清理的资源
    let abortController: AbortController | null = null
    let overlay: FileOverlay | null = null

    if (this._state.kind === 'running') {
      abortController = this._state.abortController
      overlay = this._state.overlay
    } else if (this._state.kind === 'done') {
      overlay = this._state.overlay
    }

    this.reset()

    abortController?.abort()
    overlay?.discard().catch(() => {})
  }

  private reset(): void {
    this._state = { kind: 'idle' }
    this._runPromise = null
  }
}

/** 全局单例 */
export const speculativeRunner = new SpeculativeRunner()
