/**
 * Mailbox — 文件式跨 agent 邮箱。
 *
 * 设计要点：
 *   - 每个 agent 一个目录 `~/.myagent/mailbox/<agent_id>/`
 *   - 每封信一个 .json 文件，文件名 `<timestamp>-<rand>.json`，自然按时序排序
 *   - 已读邮件移到子目录 `read/`，不删除（便于排查）
 *   - 写入：先写 .tmp 再 rename 到 .json（原子写，防半读）
 *   - 跨进程感知：通过轮询扫描 inbox 目录实现（`startWatching`）
 *   - 去重：全局 `deliveredMailIds` Set，所有投递路径都走 `deliverIfNew()`
 *
 * 邮件 kind:
 *   - task: leader → teammate 派任务
 *   - result: teammate → leader/teammate 汇报结果
 *   - status: teammate → leader 进度更新
 *   - close: leader → teammate 终止指令
 *   - permission: 权限申请（保留字段，本期未实现完整链路）
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { EventEmitter } from 'events'

export type MailKind = 'task' | 'result' | 'status' | 'close' | 'permission'

export interface Mail {
  id: string
  from: string
  to: string
  subject: string
  kind: MailKind
  body: string
  /** 任意自定义字段（如 task_id、ref 邮件 id） */
  meta?: Record<string, unknown>
  created_at: string
}

export interface WatchOptions {
  /** 轮询间隔（毫秒），默认 1000 */
  intervalMs?: number
}

const MAILBOX_BASE = path.join(os.homedir(), '.myagent', 'mailbox')
const mailboxEvents = new EventEmitter()

// ── 跨进程邮件投递去重 ─────────────────────────────────────────────────
// 所有投递路径（in-process send、轮询扫描）都走 deliverIfNew()，
// 用 mail.id 去重，保证同一封邮件只 emit 一次。
const deliveredMailIds = new Set<string>()

function deliverIfNew(mail: Mail): void {
  if (deliveredMailIds.has(mail.id)) return
  deliveredMailIds.add(mail.id)
  process.stderr.write(`[mailbox:deliver] ${mail.id} kind=${mail.kind} from=${mail.from} → ${mail.to} subject="${mail.subject}"\n`)
  mailboxEvents.emit(mailboxEvent(mail.to), mail)
}

// ── 轮询定时器管理 ─────────────────────────────────────────────────────
const pollingTimers = new Map<string, ReturnType<typeof setInterval>>()

function mailboxEvent(agentId: string): string {
  return `mail:${sanitize(agentId)}`
}

function mailboxDir(agentId: string): string {
  return path.join(MAILBOX_BASE, sanitize(agentId))
}

function readDir(agentId: string): string {
  return path.join(mailboxDir(agentId), 'read')
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-.]/g, '_')
}

function ensureDirs(agentId: string): void {
  fs.mkdirSync(mailboxDir(agentId), { recursive: true })
  fs.mkdirSync(readDir(agentId), { recursive: true })
}

function genMailId(): string {
  const ts = Date.now().toString(36)
  const rand = crypto.randomBytes(4).toString('hex')
  return `${ts}-${rand}`
}

/**
 * 扫描 agentId 的 inbox 目录，将新邮件投递给本地订阅者。
 * 模块内部函数，不对外暴露。
 */
function scanAndDeliver(agentId: string): void {
  ensureDirs(agentId)
  const dir = mailboxDir(agentId)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return // 目录不存在或不可读，跳过
  }
  let newCount = 0
  for (const f of entries) {
    if (!f.endsWith('.json')) continue
    const filePath = path.join(dir, f)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const mail = JSON.parse(raw) as Mail
      // 仅通知实际收件人，防止 outgoing 回显：mail.to 必须匹配当前扫描的 agentId
      if (mail.to !== agentId) continue
      const isNew = !deliveredMailIds.has(mail.id)
      deliverIfNew(mail)
      if (isNew) newCount++
    } catch {
      // 文件可能还在写入中（.tmp 没 rename 完）、损坏、或已被移动
      // 跳过，下一轮轮询会重试
    }
  }
  if (newCount > 0) {
    process.stderr.write(`[mailbox:scan] agent=${agentId} found ${newCount} new mail(s) in inbox\n`)
  }
}

export class Mailbox {
  /**
   * 给目标 agent 发一封信，写到他的 inbox 目录。
   *
   * 采用原子写：先写 .json.tmp，再 rename 到 .json。
   * 防止轮询扫描读到半写文件。
   * 返回完整的 Mail 对象。
   */
  static send(opts: {
    from: string
    to: string
    subject: string
    kind: MailKind
    body: string
    meta?: Record<string, unknown>
  }): Mail {
    ensureDirs(opts.to)
    const mail: Mail = {
      id: genMailId(),
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      kind: opts.kind,
      body: opts.body,
      meta: opts.meta,
      created_at: new Date().toISOString(),
    }
    // 原子写：先写 .tmp 再 rename → 轮询扫描只认 .json，不会读到半成品
    const tmpFile = path.join(mailboxDir(opts.to), `${mail.id}.json.tmp`)
    const finalFile = path.join(mailboxDir(opts.to), `${mail.id}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify(mail, null, 2), 'utf-8')
    fs.renameSync(tmpFile, finalFile)
    process.stderr.write(`[mailbox:send] wrote ${mail.id} kind=${mail.kind} from=${opts.from} → ${opts.to} to ${finalFile}\n`)
    // 本进程内直接投递（快路径），跨进程靠轮询扫描
    deliverIfNew(mail)
    return mail
  }

  /**
   * 订阅 agentId 的邮件到达事件。
   * 返回 unsubscribe 函数。
   *
   * 注意：此订阅覆盖两类来源：
   *   1. 本进程 Mailbox.send() → deliverIfNew() → emit
   *   2. 跨进程写入 → startWatching 轮询扫描 → deliverIfNew() → emit
   */
  static subscribe(agentId: string, listener: (mail: Mail) => void): () => void {
    const event = mailboxEvent(agentId)
    mailboxEvents.on(event, listener)
    return () => mailboxEvents.off(event, listener)
  }

  /**
   * 等待 agentId 收到新邮件（单次 Promise）。
   * 用于 teammate keepAlive 模式：挂起直到有邮件到达或 signal abort。
   */
  static waitForMail(agentId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const unsubscribe = Mailbox.subscribe(agentId, done)
      const abort = () => done()

      function done(): void {
        unsubscribe()
        signal?.removeEventListener('abort', abort)
        resolve()
      }

      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /**
   * 启动 agentId 的邮箱监听（轮询模式）。
   *
   * 启动时立即扫描一次（处理启动前已有的邮件），
   * 之后按 intervalMs 间隔定期扫描 inbox 目录。
   * 发现新邮件后通过 deliverIfNew → mailboxEvents 投递给订阅者。
   *
   * 重复调用同一个 agentId 是安全的（已启动则跳过）。
   */
  static startWatching(agentId: string, options: WatchOptions = {}): void {
    const key = sanitize(agentId)
    if (pollingTimers.has(key)) return // 已在监听

    const intervalMs = options.intervalMs ?? 1000

    // 注意：不在启动时立即扫描。原因是 Mailbox.startWatching 在 render(App)
    // 之前调用，而 App 的 useEffect 才注册 subscribe 回调。如果此时扫描到旧邮件，
    // deliverIfNew 会将 mail.id 加入 deliveredMailIds 全局去重集合，但此时零 listener，
    // 后续轮询再遇到同一邮件时 deliveredMailIds 拦截 → 回调永不触发。
    //
    // 改为依赖定时轮询的第一次触发（≤ intervalMs），此时 App 已 mount 完毕，
    // subscribeMainMailbox 回调已注册到位。

    // 定时轮询
    const timer = setInterval(() => {
      scanAndDeliver(agentId)
    }, intervalMs)

    // unref 让定时器不阻止进程退出（TUI 模式下 Ink 会保持事件循环）
    timer.unref()

    pollingTimers.set(key, timer)
  }

  /**
   * 停止 agentId 的邮箱监听。
   * 测试清理 / 进程退出时调用。
   */
  static stopWatching(agentId: string): void {
    const key = sanitize(agentId)
    const timer = pollingTimers.get(key)
    if (timer) {
      clearInterval(timer)
      pollingTimers.delete(key)
    }
  }

  /** agentId 的收件箱是否有未读邮件。 */
  static hasUnread(agentId: string): boolean {
    return Mailbox.list(agentId).length > 0
  }

  /** 列出某个 agent 收件箱中的未读邮件，可按 kind 过滤。 */
  static list(agentId: string, filter?: { kind?: MailKind; from?: string }): Mail[] {
    ensureDirs(agentId)
    const dir = mailboxDir(agentId)
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    const mails: Mail[] = []
    for (const f of entries) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8')
        const m = JSON.parse(raw) as Mail
        if (filter?.kind && m.kind !== filter.kind) continue
        if (filter?.from && m.from !== filter.from) continue
        mails.push(m)
      } catch {
        // 损坏文件跳过
      }
    }
    mails.sort((a, b) => a.created_at.localeCompare(b.created_at))
    return mails
  }

  /** 取出（标记为已读）一封信：从 inbox 移到 read/ 子目录。 */
  static markRead(agentId: string, mailId: string): boolean {
    ensureDirs(agentId)
    const src = path.join(mailboxDir(agentId), `${mailId}.json`)
    if (!fs.existsSync(src)) return false
    const dst = path.join(readDir(agentId), `${mailId}.json`)
    fs.renameSync(src, dst)
    // 从全局去重集合中移除，防止 deliveredMailIds 只增不删导致内存泄漏
    deliveredMailIds.delete(mailId)
    return true
  }

  /** 取出第一封符合条件的未读信，并标记为已读；空返回 null。 */
  static popFirst(agentId: string, filter?: { kind?: MailKind; from?: string }): Mail | null {
    const list = Mailbox.list(agentId, filter)
    if (list.length === 0) return null
    const m = list[0]
    Mailbox.markRead(agentId, m.id)
    return m
  }

  /** 清空一个 agent 的整个邮箱（含已读）。测试 / 收尾用。 */
  static destroy(agentId: string): void {
    Mailbox.stopWatching(agentId)
    fs.rmSync(mailboxDir(agentId), { recursive: true, force: true })
  }
}

/** 把邮件渲染成可读字符串（给 LLM 看）。正文超过 1000 字符时截断。 */
export function formatMail(m: Mail): string {
  const MAX_BODY = 1000
  const body = m.body.length > MAX_BODY
    ? m.body.slice(0, MAX_BODY) + `\n…[截断 ${m.body.length - MAX_BODY} 字符，完整内容通过 check_mail(mode=pop) 读取]`
    : m.body
  const metaStr = m.meta ? `\nmeta: ${JSON.stringify(m.meta)}` : ''
  return [
    `[${m.id}] kind=${m.kind} from=${m.from} → ${m.to}`,
    `subject: ${m.subject}`,
    `created_at: ${m.created_at}${metaStr}`,
    '',
    body,
  ].join('\n')
}
