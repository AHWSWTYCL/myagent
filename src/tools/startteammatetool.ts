import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import type { AgentRunContext } from '../agents/definition.js'
import { Mailbox } from '../mailbox/mailbox.js'
import { TeamManager } from '../team/team.js'

/**
 * StartTeammateTool — leader 专属工厂工具。
 *
 * 它内部调用主 toolRegistrar 中的 `agent` 工具来启动 teammate，
 * 但强制：
 *   - agent: 'teammate'
 *   - background: true
 *
 * 这样 leader 不可能漏掉 background=true，避免被 300s 同步超时砍断。
 * 同时 leader 也无法用它启动其他类型 agent（边界意识）。
 *
 * 如果传入 task，工具会**先**把 task 写进 teammate 邮箱（kind=task）再启动它，
 * 避免出现 teammate 启动 → check_mail → 空 → idle 的 race condition。
 */
export class StartTeammateTool extends Tool {
  constructor(
    private readonly ctx: AgentRunContext,
    private readonly leaderId: string,
  ) {
    super()
  }

  get name(): string { return 'start_teammate' }

  get description(): string {
    return [
      'Spawn a teammate worker in the background. The teammate has its own mailbox identified by agent_id and runs a check_mail/work loop.',
      'Background execution is enforced internally — you do not need to (and cannot) override it.',
      'If you provide `task`, it will be pre-delivered to the teammate\'s mailbox as a kind=task mail BEFORE the worker starts, so the worker has something to do on its very first check_mail. This is the recommended path for the initial dispatch.',
      'If you provide `team_name`, the teammate will be registered as a member of that team (create the team first with create_team).',
      'For follow-up tasks, use send_mail (kind=task, to=<agent_id>) directly.',
    ].join(' ')
  }

  get inputSchemaZod() {
    return z.object({
      agent_id: z.string().describe('Unique mailbox id for this teammate (e.g. "wk-gen-1")'),
      role: z.string().describe('One-line specialty description, e.g. "code generator"'),
      tools: z.string().describe('Comma-separated tool names this teammate may use besides mail tools, e.g. "read_file,write_file,bash"'),
      peers: z.string().optional().describe('Optional comma-separated peer teammate ids for direct collaboration'),
      task: z.string().optional().describe('Optional initial task body. If set, will be pre-delivered to teammate mailbox as kind=task before spawning.'),
      task_subject: z.string().optional().describe('Subject of the initial task mail (default: "initial task")'),
      team_name: z.string().optional().describe('Optional team name. If set, register this teammate as a member of that team. Create the team first with create_team.'),
    })
  }

  get outputSchemaZod() { return z.string() }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    return {
      label: 'StartTeammate',
      args: `${input.agent_id ?? '?'} (${Tool.truncate(String(input.role ?? ''), 40)})`,
    }
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: {
    agent_id: string
    role: string
    tools: string
    peers?: string
    task?: string
    task_subject?: string
    team_name?: string
  }): Promise<string> {
    const { agent_id, role, tools, peers, task, task_subject, team_name } = args

    // 1. 先把 initial task 直接写到 teammate 邮箱（避免 race：worker 启动后第一次
    //    check_mail 可能在 leader 后续 send_mail 之前就跑了）
    let preDelivered = ''
    if (task && task.trim()) {
      const m = Mailbox.send({
        from: this.leaderId,
        to: agent_id,
        subject: task_subject ?? 'initial task',
        kind: 'task',
        body: task,
      })
      preDelivered = ` (initial task pre-delivered as mail ${m.id})`
    }

    // 2. 再启动 worker。注意：传给 agent 工具的 task 字段对 teammate definition
    //    只是 first-turn user message 的提示，工作逻辑还是依赖邮箱里的 task 邮件。
    const launchOut = await this.ctx.executeTool('agent', {
      agent: 'teammate',
      background: true,
      agent_id,
      leader_id: this.leaderId,
      role,
      tools,
      peers,
      team_name,
    })

    // 3. 如果指定了 team_name，注册 teammate 到 team
    let teamNote = ''
    if (team_name) {
      if (TeamManager.exists(team_name)) {
        TeamManager.addMember(team_name, agent_id, role)
        teamNote = `\nRegistered in team "${team_name}".`
      } else {
        teamNote = `\nWarning: team "${team_name}" does not exist. Create it first with create_team. Teammate spawned but not registered.`
      }
    }

    return launchOut + preDelivered + teamNote
  }
}
