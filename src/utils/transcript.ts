/**
 * TranscriptRecorder — session 级转录文件机制
 *
 * 设计意图：
 *   将一次 myagent 进程生命周期中所有关键事件（用户输入、LLM 请求/响应、
 *   工具调用、sub-agent 启动/结束、background handoff、上下文压缩等）
 *   以 NDJSON 格式写入文件，并区分 agent 层级（main vs bg vs sub-agent）。
 *
 * 三个用途：
 *   1. 可观测性/调试 — 通过 agentId 过滤查看特定 agent 的完整执行轨迹
 *   2. Session 恢复 — checkpoint 事件保存 messages 快照，支持重启后重建上下文
 *   3. 后台 agent 完整轨迹 — background loop 也走同一套事件写入，agentId=bg-xxx
 *
 * 文件布局：
 *   .myagent/sessions/YYYY-MM-DD/session-<ts>-<rand>/
 *     transcript.ndjson
 *     artifacts/  (tool 输出 >5KB 时转存至此)
 *
 * NDJSON 格式（每行一个 JSON 对象）：
 *   {"type":"session_start","ts":"...","agentId":"session","parentAgentId":null,"data":{...}}
 *   {"type":"tool_start","ts":"...","agentId":"main","parentAgentId":null,"data":{...}}
 *   ...
 *
 * 使用方式（单例，由 agent.ts 创建）：
 *   const recorder = new TranscriptRecorder()
 *   recorder.initSession()
 *   recorder.pushAgentContext('main', null)
 *   recorder.recordUserInput(...)
 *   // ... foreground loop calls recorder.recordToolStart/End etc ...
 *   recorder.popAgentContext()
 *   recorder.closeSession()
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { UsageAccum } from './runagent.js'

// ── Constants ───────────────────────────────────────────────────────

const SESSIONS_ROOT = path.join(process.cwd(), '.myagent', 'sessions')
/** Tool output 超过此阈值（5KB）转存 artifact 文件，不 inline 进 NDJSON */
const ARTIFACT_SIZE_THRESHOLD = 5 * 1024
/** 默认保留最近 N 天的 session 文件（可通过 MYAGENT_SESSION_DAYS 环境变量覆盖） */
const DEFAULT_SESSION_DAYS = 7

// ── Agent context stack ─────────────────────────────────────────────

interface AgentContext {
  agentId: string
  parentAgentId: string | null
}

// ── Event data types ────────────────────────────────────────────────

export interface SessionStartData {
  sessionId: string
  pid: number
  cwd: string
  nodeVersion: string
  /** 如果本次 session 是恢复某个旧 session，记录原 sessionId */
  continuedFrom?: string
}

export interface SessionEndData {
  duration: number
  totalEvents: number
}

export interface UserInputData {
  text: string
  charLength: number
}

export interface LLMRequestData {
  model: string
  turn: number
  messageCount: number
}

export interface LLMResponseEndData {
  text: string
  stopReason: string | undefined
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
}

export interface ToolStartData {
  callId: string
  toolName: string
  input: unknown
}

export interface ToolEndData {
  callId: string
  toolName: string
  input: unknown
  outputLength: number
  /** artifact 相对路径（有值时表示输出过大已转存，inline output 为空） */
  artifact?: string
  /** 输出第一行摘要（≤5KB 时是完整内容，>5KB 时是前 500 字符截断） */
  outputSummary: string
  isError: boolean
}

export interface SubAgentStartData {
  agentType: string
  description: string
}

export interface SubAgentEndData {
  agentType: string
  error?: string
  toolUseCount: number
}

export interface CheckpointData {
  messageCount: number
  tokenEstimate: number
  /** checkpoint 文件路径（相对 sessionDir），内含 messages 数组的全量序列化 */
  checkpointFile: string
}

export interface BackgroundHandoffData {
  taskId: string
  forkedMessageCount: number
}

export interface CompactData {
  beforeTokens: number
  afterMessages: number
}

// ── Event union ─────────────────────────────────────────────────────

export type TranscriptEvent =
  | { type: 'session_start'; data: SessionStartData }
  | { type: 'session_end'; data: SessionEndData }
  | { type: 'user_input'; data: UserInputData }
  | { type: 'llm_request'; data: LLMRequestData }
  | { type: 'llm_response_end'; data: LLMResponseEndData }
  | { type: 'tool_start'; data: ToolStartData }
  | { type: 'tool_end'; data: ToolEndData }
  | { type: 'sub_agent_start'; data: SubAgentStartData }
  | { type: 'sub_agent_end'; data: SubAgentEndData }
  | { type: 'checkpoint'; data: CheckpointData }
  | { type: 'background_handoff'; data: BackgroundHandoffData }
  | { type: 'compact'; data: CompactData }

// ── TranscriptRecorder ──────────────────────────────────────────────

export class TranscriptRecorder {
  /** Session 标识：session-<timestamp4>-<random4> */
  private sessionId = ''
  /** 输出目录：.myagent/sessions/YYYY-MM-DD/session-xxx/ */
  private sessionDir = ''
  /** NDJSON 文件路径 */
  private transcriptPath = ''
  /** Agent 上下文栈（栈顶 = 当前 agent） */
  private contextStack: AgentContext[] = []
  /** 事件计数器（用于 artifact 命名和 session_end 统计） */
  private eventCount = 0
  /** artifact 序列号 */
  private artifactSeq = 0
  /** checkpoint 序列号 */
  private checkpointSeq = 0
  /** Session 开始时间 */
  private startTime = 0

  // ── Session lifecycle ─────────────────────────────────────────────

  /**
   * 初始化 session：
   *   1. 创建 session 目录
   *   2. 写入 session_start 事件（同步）
   *
   * @param continuedFrom 如果本次 session 是恢复旧 session，传原 sessionId
   */
  initSession(continuedFrom?: string): void {
    // 启动新 session 前，先清理过期的旧 session
    cleanOldSessions()

    this.startTime = Date.now()
    this.sessionId = this.generateSessionId()
    this.sessionDir = this.buildSessionDir()
    this.transcriptPath = path.join(this.sessionDir, 'transcript.ndjson')
    this.ensureDir(this.sessionDir)
    this.ensureDir(path.join(this.sessionDir, 'artifacts'))

    // 默认 agent 上下文
    this.contextStack = [{ agentId: 'session', parentAgentId: null }]

    const data: SessionStartData = {
      sessionId: this.sessionId,
      pid: process.pid,
      cwd: process.cwd(),
      nodeVersion: process.version,
    }
    if (continuedFrom) data.continuedFrom = continuedFrom

    this.writeEventSync({
      type: 'session_start',
      data,
    })
  }

  /**
   * 关闭 session：
   *   写入 session_end 事件。
   *   写入 .closed 标记文件供 -c 恢复时识别。
   *   所有事件已同步落盘，可直接读取产物。
   */
  closeSession(): void {
    if (!this.transcriptPath) return
    if (!fs.existsSync(this.transcriptPath)) return

    this.writeEventSync({
      type: 'session_end',
      data: {
        duration: Date.now() - this.startTime,
        totalEvents: this.eventCount,
      },
    })

    // 写入 .closed 标记文件，标识 session 正常关闭
    // 仅含 .closed 标记的 session 会被 -c 识别为可恢复
    this.writeClosedMarker()
  }

  /**
   * 写入 .closed 标记文件（JSON），包含 sessionId 和关闭时间戳。
   * 文件路径：{sessionDir}/.closed
   */
  private writeClosedMarker(): void {
    if (!this.sessionDir) return
    const markerPath = path.join(this.sessionDir, '.closed')
    const marker = {
      sessionId: this.sessionId,
      closedAt: new Date().toISOString(),
      duration: Date.now() - this.startTime,
      totalEvents: this.eventCount,
    }
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf-8')
  }

  // ── Agent context stack ───────────────────────────────────────────

  /**
   * 推入一个新的 agent 上下文。
   * 之后所有事件（直至 pop）的 agentId / parentAgentId 由此确定。
   */
  pushAgentContext(agentId: string, parentAgentId: string | null): void {
    this.contextStack.push({ agentId, parentAgentId })
  }

  /** 弹出当前 agent 上下文，恢复上一个。 */
  popAgentContext(): void {
    if (this.contextStack.length > 1) {
      this.contextStack.pop()
    }
  }

  /** 获取当前 agent 上下文。 */
  private get currentContext(): AgentContext | undefined {
    return this.contextStack[this.contextStack.length - 1]
  }

  // ── Event recorders ───────────────────────────────────────────────

  recordUserInput(input: string | Array<Anthropic.TextBlockParam>): void {
    const text = typeof input === 'string'
      ? input
      : input.filter(b => b.type === 'text').map(b => b.text).join('\n')
    this.writeEventSync({
      type: 'user_input',
      data: {
        text: text.length > 500 ? text.slice(0, 497) + '…' : text,
        charLength: text.length,
      },
    })
  }

  recordLLMRequest(model: string, turn: number, messages: Anthropic.MessageParam[]): void {
    this.writeEventSync({
      type: 'llm_request',
      data: { model, turn, messageCount: messages.length },
    })
  }

  recordLLMResponseEnd(
    text: string,
    usage: UsageAccum,
    stopReason: string | undefined,
  ): void {
    this.writeEventSync({
      type: 'llm_response_end',
      data: {
        text: text.length > 2000 ? text.slice(0, 1997) + '…' : text,
        stopReason,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
      },
    })
  }

  recordToolStart(callId: string, toolName: string, input: unknown): void {
    this.writeEventSync({
      type: 'tool_start',
      data: { callId, toolName, input },
    })
  }

  recordToolEnd(
    callId: string,
    toolName: string,
    input: unknown,
    output: string,
  ): void {
    const isError = output.startsWith('Error:')
    const outputLength = output.length

    let artifact: string | undefined
    let outputSummary: string

    if (outputLength > ARTIFACT_SIZE_THRESHOLD) {
      // 写入 artifact 文件
      this.artifactSeq++
      const artifactName = `${String(this.artifactSeq).padStart(3, '0')}_${toolName}_${callId.slice(0, 8)}.log`
      const artifactPath = path.join(this.sessionDir, 'artifacts', artifactName)
      fs.writeFileSync(artifactPath, output, 'utf-8')
      artifact = `artifacts/${artifactName}`
      outputSummary = output.slice(0, 500) + `\n… (truncated, full: ${outputLength} chars in ${artifact})`
    } else {
      outputSummary = output
    }

    this.writeEventSync({
      type: 'tool_end',
      data: {
        callId,
        toolName,
        input,
        outputLength,
        artifact,
        outputSummary,
        isError,
      },
    })
  }

  recordSubAgentStart(agentType: string, description: string): void {
    this.writeEventSync({
      type: 'sub_agent_start',
      data: { agentType, description },
    })
  }

  recordSubAgentEnd(agentType: string, error?: string, toolUseCount = 0): void {
    this.writeEventSync({
      type: 'sub_agent_end',
      data: { agentType, error, toolUseCount },
    })
  }

  recordCheckpoint(messages: Anthropic.MessageParam[]): void {
    this.checkpointSeq++
    const tokenEst = this.estimateTokens(messages)
    const cpName = `checkpoint-${this.checkpointSeq}.json`
    const cpPath = path.join(this.sessionDir, cpName)

    // 写入全量 checkpoint 文件
    const cpContent = {
      seq: this.checkpointSeq,
      timestamp: new Date().toISOString(),
      messageCount: messages.length,
      tokenEstimate: tokenEst,
      messages,
    }
    fs.writeFileSync(cpPath, JSON.stringify(cpContent, null, 2), 'utf-8')

    // 轻量 NDJSON 事件只引用文件路径
    this.writeEventSync({
      type: 'checkpoint',
      data: {
        messageCount: messages.length,
        tokenEstimate: tokenEst,
        checkpointFile: cpName,
      },
    })
  }

  recordBackgroundHandoff(taskId: string, forkedMessageCount: number): void {
    this.writeEventSync({
      type: 'background_handoff',
      data: { taskId, forkedMessageCount },
    })
  }

  recordCompact(beforeTokens: number, afterMessages: number): void {
    this.writeEventSync({
      type: 'compact',
      data: { beforeTokens, afterMessages },
    })
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * 写入一行 NDJSON 事件（同步 appendFileSync）。
   * 每行格式：{"type":"xxx","ts":"2026-06-05T...","agentId":"xxx","parentAgentId":"xxx","data":{...}}
   */
  private writeEventSync(event: TranscriptEvent): void {
    if (!this.transcriptPath) return
    this.eventCount++

    const ctx = this.currentContext
    const line = JSON.stringify({
      ...event,
      ts: new Date().toISOString(),
      agentId: ctx?.agentId ?? 'unknown',
      parentAgentId: ctx?.parentAgentId ?? null,
    }) + '\n'

    fs.appendFileSync(this.transcriptPath, line, 'utf-8')
  }

  /** 生成 session ID：session-<timestamp4>-<random4> */
  private generateSessionId(): string {
    const ts = Date.now().toString(36).slice(-4)
    const rand = crypto.randomBytes(2).toString('hex')
    return `session-${ts}-${rand}`
  }

  /** 构建 session 目录路径：.myagent/sessions/YYYY-MM-DD/session-xxx/ */
  private buildSessionDir(): string {
    const dateStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    return path.join(SESSIONS_ROOT, dateStr, this.sessionId)
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  /** 粗略估算 messages 的 token 数（4 chars ≈ 1 token） */
  private estimateTokens(messages: Anthropic.MessageParam[]): number {
    let total = 0
    for (const m of messages) {
      if (typeof m.content === 'string') {
        total += m.content.length
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if ('text' in block && typeof block.text === 'string') {
            total += block.text.length
          }
        }
      }
    }
    return Math.round(total / 4)
  }
}

// ── Session cleanup ────────────────────────────────────────────────────

/**
 * 清理超过指定天数的旧 session 目录。
 *
 * 设计意图：
 *   每次启动新 session 时自动触发，避免 session 文件无限积累。
 *   只删除含 .closed 标记（正常关闭）的 session，忽略正在运行或崩溃的 session。
 *   按 .closed 文件的修改时间（mtime）判断关停时间。
 *
 * 行为：
 *   - 保留最近 N 天内的 session（默认 7 天，可被 MYAGENT_SESSION_DAYS 覆盖）
 *   - 超出保留期的 session 整个目录递归删除（含 checkpoint，不可恢复）
 *   - 日期目录下所有 session 被清空后，自动删除空目录
 *   - 清理失败静默忽略，不影响主流程
 *
 * 与 cleanOldResults (backgroundStorage.ts) 保持一致的 error-silent 风格。
 */
export function cleanOldSessions(daysToKeep?: number): void {
  try {
    if (!fs.existsSync(SESSIONS_ROOT)) return

    const keepDays = daysToKeep ?? getEnvSessionDays()
    const now = Date.now()
    const maxAge = keepDays * 24 * 60 * 60 * 1000

    for (const dateDir of fs.readdirSync(SESSIONS_ROOT)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue

      const datePath = path.join(SESSIONS_ROOT, dateDir)
      const sessionDirs = fs.readdirSync(datePath).filter(d => d.startsWith('session-'))

      for (const sessionDir of sessionDirs) {
        const sessionPath = path.join(datePath, sessionDir)
        const closedPath = path.join(sessionPath, '.closed')

        // 只清理含 .closed 标记的 session（正常关闭的）
        if (!fs.existsSync(closedPath)) continue

        const closedStat = fs.statSync(closedPath)
        if (now - closedStat.mtimeMs > maxAge) {
          fs.rmSync(sessionPath, { recursive: true, force: true })
        }
      }

      // 日期目录下已无 session，清理空目录
      const remaining = fs.readdirSync(datePath).filter(d => d.startsWith('session-'))
      if (remaining.length === 0) {
        fs.rmdirSync(datePath)
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
}

/** 读取 MYAGENT_SESSION_DAYS 环境变量，非法值回退到默认值 */
function getEnvSessionDays(): number {
  const val = process.env.MYAGENT_SESSION_DAYS
  if (!val) return DEFAULT_SESSION_DAYS
  const n = parseInt(val, 10)
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_SESSION_DAYS
}

// ── Session recovery ────────────────────────────────────────────────────

export interface CheckpointSnapshot {
  sessionId: string
  sessionDir: string
  seq: number
  messages: Anthropic.MessageParam[]
  timestamp: string
}

/**
 * 从指定 session 目录中加载最新的 checkpoint，返回摘要和 messages。
 * 如果目录中没有合法 checkpoint，返回 null。
 */
function loadCheckpointFromSession(sessionPath: string, sessionDir: string): CheckpointSnapshot | null {
  try {
    const files = fs.readdirSync(sessionPath)
      .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
      .sort()
    if (files.length === 0) return null

    const latestCp = files[files.length - 1]
    const cpPath = path.join(sessionPath, latestCp)
    const raw = fs.readFileSync(cpPath, 'utf-8')
    const cp = JSON.parse(raw)

    if (!cp.messages || !Array.isArray(cp.messages) || cp.messages.length === 0) {
      return null // 空的 checkpoint 跳过
    }

    return {
      sessionId: sessionDir,
      sessionDir: sessionPath,
      seq: cp.seq ?? 0,
      messages: cp.messages as Anthropic.MessageParam[],
      timestamp: cp.timestamp ?? '',
    }
  } catch {
    return null
  }
}

/**
 * 扫描 .myagent/sessions/，找最新 session 的最新 checkpoint，返回 messages 和元信息。
 *
 * 恢复优先级：
 *   1. 优先找正常关闭（含 .closed 标记）的 session 中 mtime 最新的
 *   2. 回退：如果没有正常关闭的 session（如崩溃、SIGKILL），
 *      则从所有 session 中选含 checkpoint 且 mtime 最新的
 *
 * 按日期目录 → mtime 排序，最新的优先。
 * 如果没有可恢复的 session，返回 null。
 */
export function loadLatestCheckpoint(): CheckpointSnapshot | null {
  try {
    if (!fs.existsSync(SESSIONS_ROOT)) return null

    // 按日期目录排序，最新的优先
    const dateDirs = fs.readdirSync(SESSIONS_ROOT)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse()
    if (dateDirs.length === 0) return null

    // ── 第一轮：只找含 .closed 的 session（正常关闭的优先） ──
    const primaryResult = tryFindCheckpointInSessions(dateDirs, true)
    if (primaryResult) return primaryResult

    // ── 第二轮（回退）：没有正常关闭的 session，放宽条件 ──
    // 场景：旧 session 因未定义 .closed 写入口（SIGKILL / 进程崩溃），
    // 但 checkpoint 文件存在且内容有效，仍可恢复。
    return tryFindCheckpointInSessions(dateDirs, false)
  } catch {
    return null
  }
}

/**
 * 遍历日期目录，按 requireClosed 决定是否只考虑含 .closed 标记的 session，
 * 从最新的 session 中加载 checkpoint。
 */
function tryFindCheckpointInSessions(dateDirs: string[], requireClosed: boolean): CheckpointSnapshot | null {
  for (const dateDir of dateDirs) {
    const datePath = path.join(SESSIONS_ROOT, dateDir)
    const sessionDirs = fs.readdirSync(datePath)
      .filter(d => d.startsWith('session-'))

    // 收集候选 session，按 mtime 排序
    type Candidate = { sessionDir: string; sessionPath: string; mtime: number }
    const candidates: Candidate[] = []

    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(datePath, sessionDir)

      // requireClosed 模式下跳过没有 .closed 的 session
      if (requireClosed) {
        const closedPath = path.join(sessionPath, '.closed')
        if (!fs.existsSync(closedPath)) continue
      }

      // 必须有 checkpoint 文件才考虑
      const checkpoints = fs.readdirSync(sessionPath)
        .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'))
      if (checkpoints.length === 0) continue

      // 用 session 目录自身的 mtime 做排序（.closed 模式下用 .closed 的 mtime）
      const stat = requireClosed
        ? fs.statSync(path.join(sessionPath, '.closed'))
        : fs.statSync(sessionPath)
      candidates.push({ sessionDir, sessionPath, mtime: stat.mtimeMs })
    }

    // 按 mtime 倒序（最新的优先）
    candidates.sort((a, b) => b.mtime - a.mtime)

    for (const { sessionDir, sessionPath } of candidates) {
      const result = loadCheckpointFromSession(sessionPath, sessionDir)
      if (result) return result
    }
  }
  return null
}
