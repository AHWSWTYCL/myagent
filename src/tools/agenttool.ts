import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { ToolRegistrar } from './toolregistrar.js'
import { AgentRegistry } from '../agents/registry.js'
import { runAgent } from '../agents/runner.js'
import type { TranscriptRecorder } from '../utils/transcript.js'
import { TranscriptRecorder as TranscriptRecorderClass } from '../utils/transcript.js'
import { bgManager } from '../utils/backgroundManager.js'
import { saveBackgroundResult } from '../utils/backgroundStorage.js'
import { taskRegistry } from '../team/taskRegistry.js'
import path from 'path'
import { spawn } from 'child_process'

// ── Claude Code 外部进程配置 ───────────────────────────────────────────
/** Claude Code 外部进程超时（毫秒） */
const EXTERNAL_PROCESS_TIMEOUT_MS = 600_000 // 10 分钟
/** SIGTERM 后等待 SIGKILL 的宽限期（毫秒） */
const SIGKILL_GRACE_MS = 5_000
/** prompt 最大长度（字符数） */
const MAX_PROMPT_LENGTH = 100_000
/** stdout/stderr 最大累积字节数 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024 // 10MB

// ── Claude Code binary 路径缓存 ───────────────────────────────────────
let cachedClaudeBinary: string | null | undefined = undefined

// ── 结构化返回类型，替代 startsWith('Error') 脆弱判断 ──────────────
type ClaudeCodeResult =
  | { ok: true; output: string }
  | { ok: false; error: string }

// ── 辅助函数 ─────────────────────────────────────────────────────────

/**
 * 查找 claude CLI 是否可用。返回 binary 路径，失败返回 null。
 * 结果会被缓存（进程生命周期内不变）。
 */
async function findClaudeBinary(): Promise<string | null> {
  if (cachedClaudeBinary !== undefined) return cachedClaudeBinary

  return new Promise(resolve => {
    let settled = false
    const done = (val: string | null) => {
      if (!settled) { settled = true; cachedClaudeBinary = val; resolve(val) }
    }
    const child = spawn('which', ['claude'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.on('close', () => done(stdout.trim() || null))
    child.on('error', () => done(null))
    setTimeout(() => { child.kill(); done(null) }, 5000)
  })
}

/**
 * 通过 `claude -p` 非交互模式执行任务。
 *
 * @param prompt  任务描述（纯文本，将被传给 `claude -p`）
 * @param cwd     工作目录
 * @param signal  可选的 AbortSignal，触发时杀死子进程
 * @returns       结构化结果 { ok, output } | { ok, error }
 */
async function runClaudeCode(
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ClaudeCodeResult> {
  // ── 输入校验 ─────────────────────────────────────────────────
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: `Task description too long (${prompt.length} chars, max ${MAX_PROMPT_LENGTH})` }
  }
  if (prompt.includes('\0')) {
    return { ok: false, error: 'Task description contains invalid characters (null bytes)' }
  }

  const binary = await findClaudeBinary()
  if (!binary) {
    return { ok: false, error: 'Claude Code CLI ("claude") not found. Please install Claude Code first: https://docs.anthropic.com/en/docs/claude-code' }
  }

  // 如果外部 signal 已经触发，直接返回
  if (signal?.aborted) {
    return { ok: false, error: 'Claude Code was cancelled.' }
  }

  return new Promise(resolve => {
    let settled = false
    const done = (result: ClaudeCodeResult) => {
      if (!settled) { settled = true; resolve(result) }
    }

    const child = spawn(binary, ['-p', prompt], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // ── AbortSignal 接入 ─────────────────────────────────────
    const onAbort = () => {
      child.kill('SIGTERM')
      // 宽限期后 SIGKILL 兜底
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
      }, SIGKILL_GRACE_MS)
      done({ ok: false, error: 'Claude Code was cancelled.' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    // ── 输出收集（带上限） ─────────────────────────────────
    const chunks: Buffer[] = []
    let totalBytes = 0
    const onData = (d: Buffer) => {
      if (totalBytes < MAX_OUTPUT_BYTES) {
        chunks.push(d)
        totalBytes += d.length
      } else if (totalBytes >= MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM')
        setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* 可能已退出 */ }
        }, SIGKILL_GRACE_MS)
        done({ ok: false, error: `Claude Code output exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024}MB limit, killed.` })
      }
    }

    let stderr = ''
    child.stdout.on('data', onData)
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    // ── 超时处理 ────────────────────────────────────────────
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 可能已退出 */ }
      }, SIGKILL_GRACE_MS)
      done({ ok: false, error: `Claude Code timed out after ${EXTERNAL_PROCESS_TIMEOUT_MS / 1000}s. Consider simplifying the task.` })
    }, EXTERNAL_PROCESS_TIMEOUT_MS)

    // ── 进程结束 ─────────────────────────────────────────────
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)

      const out = Buffer.concat(chunks).toString('utf8').trim()
      const err = stderr.trim()

      if (code !== 0 && code !== null) {
        const msg = out || err || `exit code ${code}`
        done({ ok: false, error: `Claude Code exited with code ${code}:\n${msg}` })
        return
      }

      let output = out
      if (!output && err) {
        output = `[Claude Code output on stderr]\n${err}`
      } else if (err) {
        output += `\n\n[stderr]\n${err}`
      }

      done({ ok: true, output: output || '(Claude Code produced no output)' })
    })

    // ── spawn 错误（如 binary 不存在、权限不足） ────────────
    child.on('error', err => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      done({ ok: false, error: `Claude Code spawn failed: ${err.message}` })
    })
  })
}

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
  // 缓存：避免每轮 LLM 调用都重建 description 和 input_schema
  private _descCache?: string
  private _schemaCache?: { type: 'object'; properties: object; required: string[] }
  private _agentCount = -1

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
    const taskFirstLine = task.split('\n')[0]
    return { label, args: taskFirstLine ? Tool.truncate(taskFirstLine, 100) : '' }
  }

  renderToolResult(output: string, isError: boolean): string[] {
    return Tool.summarize(output, isError)
  }

  /** agent 列表变化时自动失效缓存 */
  private isCacheValid(): boolean {
    return this._agentCount === this.registry.list().length && this._agentCount >= 0
  }

  private invalidateCache(): void {
    this._agentCount = this.registry.list().length
    this._descCache = undefined
    this._schemaCache = undefined
  }

  get description(): string {
    if (!this.isCacheValid()) this.invalidateCache()
    if (this._descCache) return this._descCache
    // system prompt 中已有完整 agent 描述（describeForPrompt），此处只需列出 agent 名
    // 供 LLM 做参数匹配，不重复大段描述
    const names = this.registry.list().map(a => a.name).join(', ')
    this._descCache = `Spawn a sub-agent. Pick \`agent\` from: ${names}. See system prompt for each agent's capabilities.`
    return this._descCache
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
    if (!this.isCacheValid()) this.invalidateCache()
    if (this._schemaCache) return this._schemaCache

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
        // 只保留 type 信息，去掉 description — LLM 从 system prompt 已知各 agent 能力
        properties[k] = { type: (v as any).type }
      }
    }
    this._schemaCache = {
      type: 'object',
      properties,
      required: ['agent'],
    }
    return this._schemaCache
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

    // ── 外部进程型 agent ──────────────────────────────────────────────
    // 不走 LLM 循环，直接 spawn 外部 CLI 进程并返回结果。
    if (def.agentType === 'external-process') {
      if (!agentDescription) {
        return `Error: agent "${agentName}" requires a task description`
      }
      const cwd = process.cwd()
      this.emitLineFn?.(`[external] spawning ${agentName} (cwd: ${cwd})...`)
      this.onSubAgentStartFn?.(def.name, agentDescription, def.agentType)

      // Transcript 记录
      this.transcriptRecorder?.recordSubAgentStart(def.name, agentDescription)

      const result = await runClaudeCode(agentDescription, cwd, this.currentSignal)

      const status = result.ok ? 'completed' : 'failed'
      this.onSubAgentDoneFn?.(def.name, status)
      this.transcriptRecorder?.recordSubAgentEnd(
        def.name,
        result.ok ? undefined : result.error,
      )

      return result.ok ? result.output : `Error: ${result.error}`
    }

    // ── 显式后台模式 ──────────────────────────────────────────────────
    if (args.background === true) {
      return this.runInBackground(def, args, agentName, agentDescription)
    }

    // ── 同步执行（带超时自动转后台） ──────────────────────────────────
    return this.runSyncWithTimeout(def, args, agentName, agentDescription)
  }

  /**
   * 显式后台模式：立即 fork，不等待。
   * 为 background teammate 创建独立 TranscriptRecorder，避免共享 contextStack 并发污染。
   */
  private runInBackground(
    def: NonNullable<ReturnType<AgentRegistry['get']>>,
    args: AgentToolInput,
    agentName: string,
    agentDescription: string,
  ): string {
    const { id: taskId, abortController } = bgManager.start(agentDescription)

    // ── 为 background teammate 创建独立 TranscriptRecorder ────────────
    const bgRecorder = new TranscriptRecorderClass()
    bgRecorder.initSession()
    const transcriptPath = bgRecorder.getTranscriptPath()

    // ── 注册 teammate 到 taskRegistry（供 BackgroundTasksDialog 查询） ──
    const registryAgentId = def.name === 'teammate'
      ? String(args.agent_id ?? taskId)
      : undefined
    if (registryAgentId) {
      taskRegistry.register({
        agentId: registryAgentId,
        teamName: args.team_name as string | undefined,
        role: String(args.role ?? 'worker'),
        bgTaskId: taskId,
        transcriptPath,
      })
    }

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
      transcriptRecorder: bgRecorder,
      agentId: registryAgentId ?? taskId,
      parentAgentId: 'main',
    }

    // 不 await，后台执行
    runAgent(def, args, bgCtx)
      .then(result => this.finishBackgroundAgent(taskId, agentName, result, undefined, registryAgentId, bgRecorder))
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        this.finishBackgroundAgent(taskId, agentName, '', msg, registryAgentId, bgRecorder)
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
   * 对于有独立 TranscriptRecorder 的后台 agent，关闭 recorder 并更新 taskRegistry 状态。
   */
  private finishBackgroundAgent(
    taskId: string,
    agentName: string,
    text: string,
    error: string | undefined,
    registryAgentId?: string,
    bgRecorder?: TranscriptRecorder,
  ): void {
    // ── 关闭独立 transcript recorder（如果有的话） ──
    if (bgRecorder) {
      bgRecorder.closeSession()
    }

    // ── 更新 taskRegistry 状态（completed/failed），不再 remove ──
    // 这样 BackgroundTasksDialog 仍能看到已完成的 teammate 并 zoom-in 查看历史。
    if (registryAgentId) {
      taskRegistry.update(registryAgentId, {
        status: error ? 'failed' : 'completed',
      })
    }

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
