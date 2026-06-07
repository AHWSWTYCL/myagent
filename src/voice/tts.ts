/**
 * TTS 服务（基于 macOS `say` 命令）
 *
 * 设计要点：
 *   - 单例：全局共享一个播报队列，避免多个 LLM 回合声音叠加
 *   - 队列顺序播报：上一条没说完，下一条排队，不打断
 *   - stop() 立即 kill 当前 say 子进程并清空队列
 *   - 文本预处理：去掉 markdown 噪声（##、**、`、链接、emoji 等）
 *
 * 流式播报（边生成边说）：
 *   通过 feed() 喂入 LLM 流式输出的文本增量，内部按句子边界自动分割，
 *   完整句子立即送入播报队列。onTurnEnd 时调用 flush() 播报剩余 buffer。
 *   不会打断当前正在说的句子，新句子排队等候。
 *
 * 仅支持 macOS。其他平台调用 speak() 时静默忽略，并在第一次调用时打一行提示。
 */

import { spawn, type ChildProcess } from 'child_process'

/**
 * 句末分割正则。
 * 匹配「句末标点 + 空白」或「段落换行」的位置。
 * 注意使用后行断言 (?<=) 保证分割时不吃掉标点本身。
 */
const SENTENCE_BOUNDARY = /(?<=[。！？.!?])\s+|(?<=\n)\s*/g

/** 流式 buffer 超过此长度时强制 flush（防止长时间无句子边界）。 */
const MAX_BUFFER_CHARS = 300

class TTSService {
  private enabled = false
  private voice: string | undefined          // undefined → 系统默认音色
  private rate: number | undefined           // undefined → 默认语速（约 175 wpm）
  private queue: string[] = []
  private current: ChildProcess | null = null
  private platformWarned = false

  /** 流式 feed 的原始文本 buffer（未 sanitize，避免打断 markdown 结构）。 */
  private streamBuffer = ''

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(value: boolean): void {
    this.enabled = value
    if (!value) this.stop()
  }

  getVoice(): string | undefined {
    return this.voice
  }

  setVoice(name: string | undefined): void {
    this.voice = name && name.trim() ? name.trim() : undefined
  }

  getRate(): number | undefined {
    return this.rate
  }

  setRate(wpm: number | undefined): void {
    if (wpm === undefined) {
      this.rate = undefined
      return
    }
    if (!Number.isFinite(wpm) || wpm < 50 || wpm > 500) {
      throw new Error('rate 必须在 50-500 之间（每分钟单词数）')
    }
    this.rate = Math.round(wpm)
  }

  // ── 完整文本播报（原有接口） ──────────────────────────────────────

  /**
   * 把一段完整文本送进播报队列（用于 /voice speak 或非流式场景）。
   * 文本会做 markdown 预处理，处理后为空则丢弃。
   */
  speak(text: string): void {
    if (!this.enabled) return
    if (process.platform !== 'darwin') {
      if (!this.platformWarned) {
        this.platformWarned = true
        console.log('[voice] 当前 TTS 仅支持 macOS（依赖 `say` 命令）。')
      }
      return
    }
    const cleaned = sanitizeForSpeech(text)
    if (!cleaned) return
    this.queue.push(cleaned)
    this.pump()
  }

  // ── 流式播报（边生成边说） ──────────────────────────────────────

  /**
   * 喂入一段流式文本增量。
   * 内部按句子边界缓冲分割，完整句子立即入队播报。
   * 不会打断当前正在说的句子。
   */
  feed(delta: string): void {
    if (!this.enabled) return
    if (process.platform !== 'darwin') return // platform 警告已在 speak() 中打过一次

    this.streamBuffer += delta
    this.flushBuffer()
  }

  /**
   * 结束流式输入，把剩余 buffer 播报掉。
   * 应在 onTurnEnd 中调用。
   */
  flush(): void {
    if (!this.streamBuffer) return
    const text = this.streamBuffer.trim()
    this.streamBuffer = ''
    if (text) this.speak(text)
  }

  /**
   * 按句子边界分割 streamBuffer，把完整句子送入 speak 队列。
   * - 优先按句末标点（。！？.!?）分割
   * - 段落换行（\n）也作为分割点
   * - 超过 MAX_BUFFER_CHARS 强制整段 flush
   * - 最后一个不完整的片段留在 buffer 中
   */
  private flushBuffer(): void {
    const buf = this.streamBuffer

    // 超过最大长度 → 整段 flush（防长时间沉默）
    if (buf.length >= MAX_BUFFER_CHARS) {
      this.streamBuffer = ''
      if (buf.trim()) this.speak(buf)
      return
    }

    // 按句子边界分割
    const parts = buf.split(SENTENCE_BOUNDARY)
    if (parts.length <= 1) return // 还没有完整句子

    // 最后一段可能不完整，留在 buffer
    this.streamBuffer = parts.pop() ?? ''

    for (const part of parts) {
      const trimmed = part.trim()
      if (trimmed) this.speak(trimmed)
    }
  }

  // ── 控制 ──────────────────────────────────────────────────────────

  /** 立即停止当前播报并清空队列。同时丢弃未完成的 stream buffer。 */
  stop(): void {
    this.queue.length = 0
    this.streamBuffer = ''
    if (this.current) {
      try { this.current.kill('SIGTERM') } catch { /* ignore */ }
      this.current = null
    }
  }

  /** 队列驱动：当前没在说时，取下一条交给 say 子进程。 */
  private pump(): void {
    if (this.current) return
    const next = this.queue.shift()
    if (!next) return

    const args: string[] = []
    if (this.voice) args.push('-v', this.voice)
    if (this.rate !== undefined) args.push('-r', String(this.rate))
    args.push(next)

    const child = spawn('say', args, { stdio: 'ignore' })
    this.current = child
    child.on('exit', () => {
      this.current = null
      this.pump()
    })
    child.on('error', () => {
      this.current = null
      this.pump()
    })
  }
}

/**
 * 把 LLM markdown 输出整理成适合朗读的纯文本：
 *   - 整段移除 ``` 代码块（朗读代码很糟糕，用一句"代码块"代替）
 *   - 移除行内 `code` 的反引号
 *   - 去掉标题 # 前缀、列表 -/* 前缀
 *   - 去掉粗体/斜体的 ** 和 _
 *   - 链接 [text](url) → text
 *   - 裸 URL → "链接"
 *   - 图片 ![alt](src) → 整段去掉
 *   - 移除常见 emoji 与符号 ✓ ✗ ● 等
 *   - 折叠多余空白
 */
export function sanitizeForSpeech(input: string): string {
  if (!input) return ''
  let s = input

  // 代码块（包括语言标签）— 用占位符代替
  s = s.replace(/```[\s\S]*?```/g, ' 代码块。 ')

  // 图片
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')

  // 链接 [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // 裸 URL
  s = s.replace(/https?:\/\/\S+/g, '链接')

  // 行内代码 — 去反引号但保留内容
  s = s.replace(/`([^`]+)`/g, '$1')

  // 粗体 / 斜体的星号或下划线（成对）
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/\*([^*]+)\*/g, '$1')
  s = s.replace(/__([^_]+)__/g, '$1')

  // 行首标题 / 列表标记
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  s = s.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
  s = s.replace(/^[ \t]*>[ \t]?/gm, '')

  // HTML 标签
  s = s.replace(/<[^>]+>/g, ' ')

  // 常见装饰符号 — 朗读时是噪声
  s = s.replace(/[●○◐◑◯⏺⊘⌖✓✗✦✨⚠⏳📋📝🔧🚀✅❌⭐]/g, ' ')

  // emoji（粗略覆盖大多数表情符号区段）
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')

  // 折叠空白
  s = s.replace(/\s+/g, ' ').trim()

  // 太短就当空：避免朗读单个标点
  if (s.length < 2) return ''

  return s
}

export const ttsService = new TTSService()
