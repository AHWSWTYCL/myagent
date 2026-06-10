/**
 * SessionManager — session 生命周期 + 元数据 + stats 的统一管理器
 */

import fs from 'fs'
import path from 'path'
import type Anthropic from '@anthropic-ai/sdk'
import { TranscriptRecorder, loadLatestCheckpoint, type CheckpointSnapshot } from '../utils/transcript.js'
import type { UsageAccum } from '../utils/runagent.js'
import { sessionState } from '../state/sessionState.js'

export interface SessionSummary {
  sessionId: string
  sessionDir: string
  createdAt: string
  closedAt?: string
  isClosed: boolean
  customTitle?: string
  tag?: string
  lastPrompt?: string
  stats?: {
    turns: number
    toolCalls: number
    tokensIn: number
    tokensOut: number
    compactions: number
    errors: number
  }
}

const SESSIONS_ROOT = path.join(process.cwd(), '.myagent', 'sessions')

export class SessionManager {
  private static instance: SessionManager

  private recorder: TranscriptRecorder
  private started = false
  private running = false

  private stats = {
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    compactions: 0,
    errors: 0,
    startTime: 0,
  }

  private lastPromptCache: string | undefined
  private customTitleCache: string | undefined
  private tagCache: string | undefined

  private constructor() {
    this.recorder = new TranscriptRecorder()
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager()
    }
    return SessionManager.instance
  }

  start(continuedFrom?: string): void {
    if (this.started) return
    this.started = true
    this.running = true
    this.recorder.initSession(continuedFrom)
    this.stats.startTime = Date.now()
  }

  isStarted(): boolean { return this.started }

  close(): void {
    if (!this.running) return
    this.running = false
    const sessionId = this.recorder.getSessionId()
    if (!sessionId) return
    this.recorder.recordSessionStats({
      sessionId,
      turns: this.stats.turns,
      toolCalls: this.stats.toolCalls,
      tokensIn: this.stats.tokensIn,
      tokensOut: this.stats.tokensOut,
      compactions: this.stats.compactions,
      errors: this.stats.errors,
    })
    if (this.lastPromptCache) this.recorder.recordLastPrompt(this.lastPromptCache, sessionId)
    if (this.customTitleCache) this.recorder.recordCustomTitle(this.customTitleCache, sessionId)
    if (this.tagCache) this.recorder.recordTag(this.tagCache, sessionId)
    this.recorder.closeSession()
  }

  restoreFromCheckpoint(checkpoint: CheckpointSnapshot): void {
    sessionState.hydrate(checkpoint.messages, checkpoint.sessionId)
    this.stats.startTime = Date.now()
  }

  get continuedFromSession(): string | undefined { return sessionState.continuedFromSession }

  setCustomTitle(title: string): void {
    this.customTitleCache = title
    const id = this.recorder.getSessionId()
    if (id) this.recorder.recordCustomTitle(title, id)
  }

  setTag(tag: string): void {
    this.tagCache = tag
    const id = this.recorder.getSessionId()
    if (id) this.recorder.recordTag(tag, id)
  }

  setLastPrompt(prompt: string): void {
    const flat = prompt.replace(/\n/g, ' ').trim()
    this.lastPromptCache = flat.length > 200 ? flat.slice(0, 200).trim() + '...' : flat
  }

  getCustomTitle(): string | undefined { return this.customTitleCache }
  getTag(): string | undefined { return this.tagCache }

  recordTurn(usage: UsageAccum): void {
    this.stats.turns++
    this.stats.tokensIn += usage.inputTokens
    this.stats.tokensOut += usage.outputTokens
  }

  recordToolCall(): void { this.stats.toolCalls++ }
  recordError(): void { this.stats.errors++ }
  recordCompaction(): void { this.stats.compactions++ }

  getStats() { return { ...this.stats } }

  getSessionId(): string { return this.recorder.getSessionId() }
  getSessionDir(): string { return this.recorder.getSessionDir() }
  getRecorder(): TranscriptRecorder { return this.recorder }

  recordCheckpoint(messages: Anthropic.MessageParam[]): void {
    this.recorder.recordCheckpoint(messages)
    const prompt = extractLastUserPrompt(messages)
    if (prompt) this.setLastPrompt(prompt)
  }

  static listSessions(): SessionSummary[] {
    const results: SessionSummary[] = []
    if (!fs.existsSync(SESSIONS_ROOT)) return results
    for (const dateDir of fs.readdirSync(SESSIONS_ROOT)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue
      const datePath = path.join(SESSIONS_ROOT, dateDir)
      const dirs = fs.readdirSync(datePath).filter(d => d.startsWith('session-'))
      for (const d of dirs) {
        const sp = path.join(datePath, d)
        const closedPath = path.join(sp, '.closed')
        const tp = path.join(sp, 'transcript.ndjson')
        const isClosed = fs.existsSync(closedPath)
        const s: SessionSummary = { sessionId: d, sessionDir: sp, createdAt: d, isClosed }
        if (isClosed) {
          try { s.closedAt = JSON.parse(fs.readFileSync(closedPath, 'utf-8')).closedAt } catch { /* */ }
        }
        if (fs.existsSync(tp)) {
          const m = readLiteMetadata(tp)
          s.customTitle = m.customTitle
          s.tag = m.tag
          s.lastPrompt = m.lastPrompt
          s.stats = m.stats
        }
        results.push(s)
      }
    }
    // 按 .closed mtime 或 session 目录 mtime 倒序（最新的优先）
    const getMtime = (s: SessionSummary): number => {
      const target = path.join(s.sessionDir, s.isClosed ? '.closed' : 'transcript.ndjson')
      try { return fs.statSync(target).mtimeMs } catch { return 0 }
    }
    results.sort((a, b) => getMtime(b) - getMtime(a))
    return results
  }

  static loadLatestCheckpoint(): CheckpointSnapshot | null {
    return loadLatestCheckpoint()
  }
}

function extractLastUserPrompt(messages: Anthropic.MessageParam[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string' && c.trim()) return c.trim()
    if (Array.isArray(c)) {
      const t = c.filter((b): b is Anthropic.TextBlockParam => b.type === 'text').map(b => b.text).join(' ').trim()
      if (t) return t
    }
  }
  return undefined
}

function readLiteMetadata(fp: string): {
  customTitle?: string; tag?: string; lastPrompt?: string
  stats?: SessionSummary['stats']
} {
  const TAIL = 16 * 1024
  try {
    const st = fs.statSync(fp)
    if (st.size === 0) return {}
    const fd = fs.openSync(fp, 'r')
    try {
      const off = Math.max(0, st.size - TAIL)
      const buf = Buffer.alloc(Math.min(TAIL, st.size - off))
      fs.readSync(fd, buf, 0, buf.length, off)
      const tail = buf.toString('utf-8')
      const r: ReturnType<typeof readLiteMetadata> = {}
      const lines = tail.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        if (!r.customTitle && line.includes('"type":"custom_title"')) {
          try { r.customTitle = JSON.parse(line).data.customTitle } catch { /* */ }
        }
        if (!r.tag && line.includes('"type":"tag"')) {
          try { r.tag = JSON.parse(line).data.tag } catch { /* */ }
        }
        if (!r.lastPrompt && line.includes('"type":"last_prompt"')) {
          try { r.lastPrompt = JSON.parse(line).data.lastPrompt } catch { /* */ }
        }
        if (!r.stats && line.includes('"type":"session_stats"')) {
          try {
            const d = JSON.parse(line).data
            if (d) r.stats = { turns: d.turns ?? 0, toolCalls: d.toolCalls ?? 0, tokensIn: d.tokensIn ?? 0, tokensOut: d.tokensOut ?? 0, compactions: d.compactions ?? 0, errors: d.errors ?? 0 }
          } catch { /* */ }
        }
        if (r.customTitle && r.tag && r.lastPrompt && r.stats) break
      }
      return r
    } finally { fs.closeSync(fd) }
  } catch { return {} }
}
