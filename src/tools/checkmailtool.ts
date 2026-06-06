import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { Mailbox, type Mail, type MailKind, formatMail } from '../mailbox/mailbox.js'
import { taskRegistry } from '../team/taskRegistry.js'

const KINDS: MailKind[] = ['task', 'result', 'status', 'close', 'permission']

export type PopStrategy = 'fifo' | 'teammatePriority'

export interface CheckMailOptions {
  /** pop 策略：fifo（默认）取最早一封；teammatePriority 按优先级取最高一封 */
  popStrategy?: PopStrategy
  /** teammatePriority 模式下 leader 的 agent_id，用于区分 leader vs peer 邮件 */
  leaderId?: string
}

/**
 * teammate 邮件优先级排序（纯函数）。
 * 返回值越小优先级越高，同优先级按 created_at FIFO。
 */
export function teammateMailPriority(m: Mail, leaderId: string): number {
  // 0. 用户输入框发送的邮件（meta.source === 'teammateView'）
  if (m.meta?.source === 'teammateView') return 0
  // 1. close 请求
  if (m.kind === 'close') return 1
  // 2. leader 发来的邮件
  if (m.from === leaderId) return 2
  // 3. peer 邮件
  return 3
}

/**
 * CheckMailTool — 读取 / 取出 自己邮箱里的信。
 *
 * mode:
 *   - peek: 只看，不标记已读（默认）
 *   - pop: 取一封并标记已读。默认 FIFO（最早一封）；注入 popStrategy='teammatePriority' 后按优先级取。
 *
 * 注意：teammate worker loop 通常使用 pop（消费式获取任务），
 *      leader 监听结果通常也用 pop。
 */
export class CheckMailTool extends Tool {
  constructor(
    private readonly selfId: string,
    private readonly options: CheckMailOptions = {},
  ) {
    super()
  }

  get name(): string { return 'check_mail' }

  get description(): string {
    return [
      'Check your own mailbox. Use mode=pop to consume the earliest matching mail (and mark it read).',
      'Use mode=peek to list without consuming. Optional kind / from filter narrows the result.',
      'Returns "(empty)" when nothing matches.',
    ].join(' ')
  }

  get inputSchemaZod() {
    return z.object({
      mode: z.enum(['peek', 'pop']).optional().describe('Default: peek'),
      kind: z.enum(KINDS as [MailKind, ...MailKind[]]).optional(),
      from: z.string().optional(),
      limit: z.number().int().positive().max(50).optional().describe('Only used in peek mode; default 10'),
    })
  }

  get outputSchemaZod() { return z.string() }

  get parallelSafe(): boolean { return true }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const mode = String(input.mode ?? 'peek')
    const kind = input.kind ? `kind=${input.kind}` : ''
    const from = input.from ? `from=${input.from}` : ''
    const filt = [kind, from].filter(Boolean).join(' ')
    return { label: 'CheckMail', args: `${mode}${filt ? ' ' + filt : ''}` }
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: {
    mode?: 'peek' | 'pop'
    kind?: MailKind
    from?: string
    limit?: number
  }): Promise<string> {
    const mode = args.mode ?? 'peek'
    if (mode === 'pop') {
      const m = this.options.popStrategy === 'teammatePriority'
        ? this.popPriority(args)
        : Mailbox.popFirst(this.selfId, { kind: args.kind, from: args.from })
      if (!m) {
        // 邮箱为空 → 如果注册在 taskRegistry 中，标记为 idle
        if (taskRegistry.get(this.selfId)) {
          taskRegistry.update(this.selfId, { status: 'idle' })
        }
        return '(empty)'
      }
      // 收到邮件 → 更新活跃状态和未读数
      if (taskRegistry.get(this.selfId)) {
        const remaining = Mailbox.list(this.selfId).length
        taskRegistry.update(this.selfId, { status: 'running', unreadCount: remaining })
      }
      return formatMail(m)
    }
    const list = Mailbox.list(this.selfId, { kind: args.kind, from: args.from })
    if (list.length === 0) {
      // peek 也是空 → idle
      if (taskRegistry.get(this.selfId)) {
        taskRegistry.update(this.selfId, { status: 'idle' })
      }
      return '(empty)'
    }
    // 有未读邮件 → 更新未读数
    if (taskRegistry.get(this.selfId)) {
      taskRegistry.update(this.selfId, { unreadCount: list.length })
    }
    const limit = args.limit ?? 10
    const slice = list.slice(0, limit)
    const head = `Found ${list.length} mail(s) (showing ${slice.length}). Use mode=pop to consume the earliest.`
    return [head, '', ...slice.map(formatMail)].join('\n\n')
  }

  /**
   * 按 teammate 优先级消费：扫描全部未读 → 按优先级排序 → 取最高 → markRead。
   * 同优先级内 FIFO（按 created_at）。
   */
  private popPriority(args: { kind?: MailKind; from?: string }): Mail | null {
    const leaderId = this.options.leaderId ?? 'leader'
    const list = Mailbox.list(this.selfId, { kind: args.kind, from: args.from })
    if (list.length === 0) return null

    // 按优先级排序，同优先级按 created_at
    list.sort((a, b) => {
      const pa = teammateMailPriority(a, leaderId)
      const pb = teammateMailPriority(b, leaderId)
      if (pa !== pb) return pa - pb
      return a.created_at.localeCompare(b.created_at)
    })

    const selected = list[0]
    Mailbox.markRead(this.selfId, selected.id)
    return selected
  }
}
