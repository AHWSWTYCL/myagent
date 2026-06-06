/**
 * Mailbox — 文件式跨 agent 邮箱。
 *
 * 设计要点：
 *   - 每个 agent 一个目录 `~/.myagent/mailbox/<agent_id>/`
 *   - 每封信一个 .json 文件，文件名 `<timestamp>-<rand>.json`，自然按时序排序
 *   - 已读邮件移到子目录 `read/`，不删除（便于排查）
 *   - 读写都是单文件原子操作，跨进程安全
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

const MAILBOX_BASE = path.join(os.homedir(), '.myagent', 'mailbox')

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

export class Mailbox {
  /** 给目标 agent 发一封信，写到他的 inbox 目录。返回邮件 id。 */
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
    const file = path.join(mailboxDir(opts.to), `${mail.id}.json`)
    fs.writeFileSync(file, JSON.stringify(mail, null, 2), 'utf-8')
    return mail
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
    fs.rmSync(mailboxDir(agentId), { recursive: true, force: true })
  }
}

/** 把邮件渲染成可读字符串（给 LLM 看）。 */
export function formatMail(m: Mail): string {
  const metaStr = m.meta ? `\nmeta: ${JSON.stringify(m.meta)}` : ''
  return [
    `[${m.id}] kind=${m.kind} from=${m.from} → ${m.to}`,
    `subject: ${m.subject}`,
    `created_at: ${m.created_at}${metaStr}`,
    '',
    m.body,
  ].join('\n')
}
