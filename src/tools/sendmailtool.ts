import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { Mailbox, type MailKind } from '../mailbox/mailbox.js'
import { taskRegistry } from '../team/taskRegistry.js'

const KINDS: MailKind[] = ['task', 'result', 'status', 'close', 'permission']

/**
 * SendMailTool — 给另一个 agent 投信。
 *
 * 由 agent definition 的 extraTools 工厂创建，构造时绑定调用方自己的 agent id（selfId），
 * 这样 LLM 不需要每次都填 from。
 */
export class SendMailTool extends Tool {
  constructor(private readonly selfId: string) {
    super()
  }

  get name(): string { return 'send_mail' }

  get description(): string {
    return [
      'Send a mail to another agent (leader or teammate). The recipient will read it via check_mail.',
      'Use kind=task to dispatch a task, kind=result to report a result, kind=status for progress updates, kind=close to terminate a teammate.',
      'meta is an optional JSON object for extra fields (e.g. task_id, ref mail id).',
    ].join(' ')
  }

  get inputSchemaZod() {
    return z.object({
      to: z.string().describe('Recipient agent id'),
      subject: z.string().describe('Short subject line'),
      kind: z.enum(KINDS as [MailKind, ...MailKind[]]).describe('Mail kind'),
      body: z.string().describe('Message body / task description / result summary'),
      meta: z.record(z.string(), z.unknown()).optional().describe('Optional extra fields as JSON object'),
    })
  }

  get outputSchemaZod() { return z.string() }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const to = String(input.to ?? '')
    const kind = String(input.kind ?? '')
    const subject = String(input.subject ?? '')
    return { label: 'SendMail', args: `[${kind}] → ${to}: ${Tool.truncate(subject, 60)}` }
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: {
    to: string
    subject: string
    kind: MailKind
    body: string
    meta?: Record<string, unknown>
  }): Promise<string> {
    const m = Mailbox.send({
      from: this.selfId,
      to: args.to,
      subject: args.subject,
      kind: args.kind,
      body: args.body,
      meta: args.meta,
    })
    // 如果调用方在 taskRegistry 中（即是一个 teammate），更新其状态
    if (taskRegistry.get(this.selfId)) {
      // 发 close 则标记为 idle（即将退出）
      if (args.kind === 'close') {
        taskRegistry.update(this.selfId, { status: 'idle' })
      } else {
        // 发了邮件 = 活跃
        taskRegistry.update(this.selfId, { status: 'running' })
      }
    }
    return `Mail ${m.id} sent to ${args.to}.`
  }
}
