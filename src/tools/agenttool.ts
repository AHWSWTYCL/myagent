import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { ToolRegistrar } from './toolregistrar.js'
import { AgentRegistry } from '../agents/registry.js'
import { runAgent } from '../agents/runner.js'
import type { TranscriptRecorder } from '../utils/transcript.js'
import { bgManager } from '../utils/backgroundManager.js'
import { saveBackgroundResult } from '../utils/backgroundStorage.js'
import path from 'path'

interface AgentToolInput {
  agent: string
  source?: string
  task?: string
  background?: boolean
  [key: string]: unknown
}

export interface BackgroundAgentResult {
  taskId: string
  name: string
  status: 'completed' | 'failed'
  text: string
  error?: string
}

/** sub-agent 同步执行超时时间（毫秒），超时后自动转入后台 */
const AGENT_TIMEOUT_MS = 300_000

/**
 * 唯一的 agent 调度入口。
 *
 * 主 LLM（或某个 sub-agent）通过它选择并启动一个 sub-agent；
 * 具体可调用的 agent 列表由注册到 AgentRegistry 中的定义决定。
 *
 * 通过 setExecutionContext 由 agent.ts 注入 client / executeTool / emitLine —
 * 这些不能在构造时拿到（循环依赖）。
 *
 * === 后台执行机制 ===
 * 支持两种方式让 sub-agent 进入后台：
 *   1. 显式：agent tool input 中加 background: true，直接 fork 后台执行
 *   2. 自动：超过 30s 未完成时自动转入后台，结果通过 XML 通知推入 messages
 */
export class AgentTool extends Tool {
  private client?: Anthropic
  private advisorClient?: Anthropic
  private executeToolFn?: (name: string, input: unknown) => Promise<string>
  private emitLineFn?: (line: string) => void
  private onSubAgentDeltaFn?: (name: string, delta: string) => void
  private onSubAgentHeartbeatFn?: (name: string, elapsedMs: number) => void
  private onSubAgentStartFn?: (name: string, description: string, agentType: string) => void
  private onSubAgentProgressFn?: (name: string, toolUseCount: number, tokenCount: number, lastActivity?: string) => void
  private onSubAgentDoneFn?: (name: string, status: 'completed' | 'failed' | 'killed', error?: string) => void
  private onBackgroundAgentResultFn?: (result: BackgroundAgentResult) => void
  private transcriptRecorder?: TranscriptRecorder
  private currentSignal?: AbortSignal

  constructor(
    private registry: AgentRegistry,
    private toolRegistrar: ToolRegistrar,
  ) { super() }

  setExecutionContext(opts: {
    client: Anthropic
    advisorClient?: Anthropic
    executeTool: (name: string, input: unknown) => Promise<string>
    emitLine: (line: string) => void
    transcriptRecorder?: TranscriptRecorder
    onSubAgentDelta?: (name: string, delta: string) => void
    onSubAgentHeartbeat?: (name: string, elapsedMs: number) => void
    onSubAgentStart?: (name: string, description: string, agentType: string) => void
    onSubAgentProgress?: (name: string, toolUseCount: number, tokenCount: number, lastActivity?: string) => void
    onSubAgentDone?: (name: string, status: 'completed' | 'failed' | 'killed', error?: string) => void
    onBackgroundAgentResult?: (result: BackgroundAgentResult) => void
  }) {
    this.client = opts.client
    this.advisorClient = opts.advisorClient
    this.executeToolFn = opts.executeTool
    this.emitLineFn = opts.emitLine
    this.transcriptRecorder = opts.transcriptRecorder
    this.onSubAgentDeltaFn = opts.onSubAgentDelta
    this.onSubAgentHeartbeatFn = opts.onSubAgentHeartbeat
    this.onSubAgentStartFn = opts.onSubAgentStart
    this.onSubAgentProgressFn = opts.onSubAgentProgress
    this.onSubAgentDoneFn = opts.onSubAgentDone
    this.onBackgroundAgentResultFn = opts.onBackgroundAgentResult
  }

  /** 设置当前 turn 的 AbortSignal，传递给 sub-agent 内部循环以实现 Esc 取消。 */
  setSignal(signal?: AbortSignal) {
    this.currentSignal = signal
  }

  get name(): string { return 'agent' }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const agentName = String(input.agent ?? 'sub-agent')
    const task = String(input.task ?? '')
    const isBg = input.background === true
    const label = isBg ? `Background(${agentName})` : `Task(${agentName})`
    return { label, args: task ? Tool.truncate(task, 100) : '' }
  }

  renderToolResult(output: string, isError: boolean): string[] {
    return Tool.summarize(output, isError)
  }

  get description(): string {
    const lines = [
      'Spawn a sub-agent to handle a self-contained task.',
      'Pick `agent` from the registered list. Each agent has its own description, allowed tools and input schema; the union of input fields is exposed below — pass only what the chosen agent expects.',
      '',
      'Available agents:',
    ]
    for (const a of this.registry.list()) {
      lines.push(`- **${a.name}** — ${a.description.replace(/\s+/g, ' ').trim()}`)
    }
    return lines.join('\n')
  }

  get inputSchemaZod() {
    const names = this.registry.list().map(a => a.name)
    // Names is built at runtime; if no agents registered yet, fall back to z.string()
    // so validation isn't impossible. enum() requires non-empty.
    const agentName = names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string()
    return z.object({
      agent: agentName,
      background: z.boolean().optional().describe('If true, run this agent in background mode and return immediately. You will be notified when it completes.'),
      task: z.string().optional(),
      source: z.string().optional(),
    }).passthrough()  // sub-agent-specific fields are validated by the agent itself
  }

  get outputSchemaZod() {
    return z.string()
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    const properties: Record<string, unknown> = {
      agent: {
        type: 'string',
        enum: this.registry.list().map(a => a.name),
        description: 'Which sub-agent to spawn.',
      },
      background: {
        type: 'boolean',
        description: 'If true, run this agent in background mode and return immediately. You will be notified when it completes.',
      },
      task: {
        type: 'string',
        description: 'High-level task description. Most agents accept this; some accept extra fields (see agent description).',
      },
      source: {
        type: 'string',
        description: 'Caller agent name (e.g. "main", "coordinator"). Optional, used for logging.',
      },
    }
    for (const a of this.registry.list()) {
      if (!a.inputSchema) continue
      for (const [k, v] of Object.entries(a.inputSchema.properties)) {
        if (k in properties) continue
        properties[k] = v
      }
    }
    return {
      type: 'object',
      properties,
      required: ['agent'],
    }
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: AgentToolInput): Promise<string> {
    if (!this.client || !this.executeToolFn || !this.emitLineFn) {
      return 'Error: AgentTool is not initialized; setExecutionContext was never called.'
    }
    const def = this.registry.get(args.agent)
    if (!def) {
      const known = this.registry.list().map(a => a.name).join(', ')
      return `Error: unknown agent "${args.agent}". Available: ${known}`
    }

    const agentName = def.name
    const agentDescription = String(args.task ?? '')

    // ── 显式后台模式 ──────────────────────────────────────────────────
    if (args.background === true) {
      return this.runInBackground(def, args, agentName, agentDescription)
    }

    // ── 同步执行（带超时自动转后台） ──────────────────────────────────
    return this.runSyncWithTimeout(def, args, agentName, agentDescription)
  }

  /**
   * 显式后台模式：立即 fork，不等待。
   */
  private runInBackground(
    def: NonNullable<ReturnType<AgentRegistry['get']>>,
    args: AgentToolInput,
    agentName: string,
    agentDescription: string,
  ): string {
    const { id: taskId, abortController } = bgManager.start(agentDescription)

    // 后台执行的上下文：大部分 TUI 回调改为 bg 兼容版
    const bgCtx = {
      source: args.source ?? 'main',
      toolRegistrar: this.toolRegistrar,
      executeTool: this.executeToolFn!,
      client: this.client!,
      advisorClient: this.advisorClient,
      emitLine: (line: string) => this.emitLineFn?.(`[bg:${agentName}] ${line}`),
      onSubAgentDelta: undefined as undefined,
      onSubAgentHeartbeat: undefined as undefined,
      onSubAgentStart: undefined as undefined,
      onSubAgentProgress: undefined as undefined,
      onSubAgentDone: undefined as undefined,
      signal: abortController.signal,
    }

    // Transcript: push bg agent context + record start
    const bgAgentId = `bg-${agentName}`
    this.transcriptRecorder?.pushAgentContext(bgAgentId, 'main')
    this.transcriptRecorder?.recordSubAgentStart(def.agentType ?? def.name, agentDescription)

    // 不 await，后台执行
    runAgent(def, args, bgCtx)
      .then(result => this.finishBackgroundAgent(taskId, agentName, result, undefined))
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        this.finishBackgroundAgent(taskId, agentName, '', msg)
      })

    return `[Background] Running agent "${agentName}" in background (${taskId}). It will push a notification when done.`
  }

  /**
   * 同步执行 + 30s 超时自动转后台。
   */
  private async runSyncWithTimeout(
    def: NonNullable<ReturnType<AgentRegistry['get']>>,
    args: AgentToolInput,
    agentName: string,
    agentDescription: string,
  ): Promise<string> {
    // Notify TUI panel that a new sub-agent started
    this.onSubAgentStartFn?.(def.name, agentDescription, def.agentType ?? 'general-purpose')

    // Transcript: push sub-agent context + record start
    const agentId = `${def.name}`
    this.transcriptRecorder?.pushAgentContext(agentId, 'main')
    this.transcriptRecorder?.recordSubAgentStart(def.agentType ?? def.name, agentDescription)

    // 构建 sub-agent 上下文
    const ctx = {
      source: args.source ?? 'main',
      toolRegistrar: this.toolRegistrar,
      executeTool: this.executeToolFn!,
      client: this.client!,
      advisorClient: this.advisorClient,
      emitLine: this.emitLineFn!,
      onSubAgentDelta: this.onSubAgentDeltaFn,
      onSubAgentHeartbeat: this.onSubAgentHeartbeatFn,
      onSubAgentStart: this.onSubAgentStartFn,
      onSubAgentProgress: this.onSubAgentProgressFn,
      signal: this.currentSignal,
    }

    try {
      // 赛跑：runAgent vs 超时
      const timeoutPromise = new Promise<'TIMEOUT'>(resolve => {
        const timer = setTimeout(() => resolve('TIMEOUT'), AGENT_TIMEOUT_MS)
        // 如果 ctx.signal 被 abort，也提前结束（不浪费超时时间）
        if (ctx.signal) {
          const onAbort = () => {
            clearTimeout(timer)
            resolve('TIMEOUT')
          }
          ctx.signal.addEventListener('abort', onAbort, { once: true })
        }
      })

      const agentPromise = runAgent(def, args, ctx)

      const winner = await Promise.race([
        agentPromise.then(r => ({ type: 'result' as const, value: r })),
        timeoutPromise.then(() => ({ type: 'timeout' as const })),
      ])

      if (winner.type === 'result') {
        // 正常完成
        this.onSubAgentDoneFn?.(def.name, 'completed')
        this.transcriptRecorder?.recordSubAgentEnd(def.agentType ?? def.name)
        this.transcriptRecorder?.popAgentContext()
        return winner.value
      }

      // 超时：转入后台
      const { id: taskId, abortController } = bgManager.start(agentDescription)

      // agentPromise 已经在运行中，attach .then() 处理结果
      agentPromise
        .then(result => this.finishBackgroundAgent(taskId, agentName, result, undefined))
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err)
          this.finishBackgroundAgent(taskId, agentName, '', msg)
        })

      // 通知 TUI agent 已转入后台
      this.onSubAgentDoneFn?.(def.name, 'completed', `timed out after ${AGENT_TIMEOUT_MS / 1000}s, moved to background (${taskId})`)
      // 注意：故意不 pop agent context — 后台 agent 仍在 transcript 中活跃
      // 当 bg agent 最终完成时，由 finishBackgroundAgent 负责 pop

      return `[Background] Agent "${agentName}" timed out after ${AGENT_TIMEOUT_MS / 1000}s, continuing in background (${taskId}). You will be notified when done.`
    } catch (err) {
      const msg = `Error running agent "${args.agent}": ${err instanceof Error ? err.message : String(err)}`
      this.onSubAgentDoneFn?.(def.name, 'failed', msg)
      this.transcriptRecorder?.recordSubAgentEnd(def.agentType ?? def.name, msg)
      this.transcriptRecorder?.popAgentContext()
      return msg
    }
  }

  /**
   * 后台 agent 完成后的统一处理：写结果文件、更新 bgManager、推通知进 messages。
   */
  private finishBackgroundAgent(
    taskId: string,
    agentName: string,
    text: string,
    error: string | undefined,
  ): void {
    // Transcript: record end + pop bg context
    if (error) {
      this.transcriptRecorder?.recordSubAgentEnd(agentName, error)
    } else {
      this.transcriptRecorder?.recordSubAgentEnd(agentName)
    }
    this.transcriptRecorder?.popAgentContext()

    if (error) {
      // 失败
      const outputPath = saveBackgroundResult(taskId, agentName, `Error: ${error}`)
      bgManager.fail(taskId, error, outputPath)
      this.onBackgroundAgentResultFn?.({
        taskId,
        name: agentName,
        status: 'failed',
        text: '',
        error,
      })
    } else {
      // 完成
      const outputPath = saveBackgroundResult(taskId, agentName, text)
      const summary = text.length > 200 ? text.slice(0, 197) + '…' : text
      bgManager.complete(taskId, outputPath, summary)
      this.onBackgroundAgentResultFn?.({
        taskId,
        name: agentName,
        status: 'completed',
        text,
      })
    }
  }
}
