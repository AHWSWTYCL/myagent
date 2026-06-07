import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import type { AgentRunContext } from '../agents/definition.js'
import { Mailbox } from '../mailbox/mailbox.js'
import { TeamManager } from '../team/team.js'
import { createLauncher, formatLaunchResult } from '../teammate/launcher.js'
import type { TeammateCliOptions } from '../teammate/teammateRuntime.js'

/**
 * StartTeammateTool — leader 专属工厂工具。
 *
 * 支持三种启动模式：
 *   - in_process (默认): 同进程运行，复用 AgentTool background
 *   - process: 通过 child_process 启动独立进程（跨平台）
 *   - warp: 在 Warp 终端新 pane 中启动（macOS，AppleScript 自动化）
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
      'Spawn a teammate worker. The teammate has its own mailbox identified by agent_id and runs a check_mail/work loop.',
      'Supports three launch modes:',
      '  - in_process (default): runs in the same Node.js process (fast, but shares crash domain)',
      '  - process: spawns as a detached child process (isolated, cross-platform)',
      '  - warp: opens in a new Warp terminal pane (visible, macOS only; falls back to process mode if automation fails)',
      'If you provide `task`, it will be pre-delivered to the teammate\'s mailbox as a kind=task mail BEFORE the worker starts.',
      'If you provide `team_name`, the teammate will be registered as a member of that team.',
      'For follow-up tasks after launch, use send_mail (kind=task, to=<agent_id>) directly.',
    ].join(' ')
  }

  get inputSchemaZod() {
    return z.object({
      agent_id: z.string().describe('Unique mailbox id for this teammate (e.g. "wk-gen-1")'),
      role: z.string().describe('One-line specialty description, e.g. "code generator"'),
      tools: z.string().describe('Comma-separated tool names this teammate may use besides mail tools, e.g. "read_file,write_file,bash"'),
      launch_mode: z.enum(['in_process', 'process', 'warp']).optional().describe('How to launch the teammate: "in_process" (default, same node process), "process" (child process), "warp" (new Warp pane, macOS only)'),
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
    launch_mode?: 'in_process' | 'process' | 'warp'
    peers?: string
    task?: string
    task_subject?: string
    team_name?: string
  }): Promise<string> {
    const { agent_id, role, tools, launch_mode = 'in_process', peers, task, task_subject, team_name } = args

    // 1. 先把 initial task 直接写到 teammate 邮箱（避免 race）
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

    // 2. 根据 launch_mode 启动 teammate
    let launchOut: string

    if (launch_mode === 'in_process') {
      // 现有 in-process 路径：通过 AgentTool background
      launchOut = await this.ctx.executeTool('agent', {
        agent: 'teammate',
        background: true,
        agent_id,
        leader_id: this.leaderId,
        role,
        tools,
        peers,
        team_name,
      })
    } else {
      // 独立进程路径（process / warp）
      const launcher = createLauncher()
      const cliOpts: TeammateCliOptions = {
        agentId: agent_id,
        leaderId: this.leaderId,
        teamName: team_name,
        role,
        tools,
        peers,
      }

      const result = await launcher.launch(cliOpts)
      launchOut = formatLaunchResult(result)

      if (result.mode === 'warp') {
        this.ctx.emitLine(`🚀 Teammate "${agent_id}" launched in Warp pane`)
      } else if (result.mode === 'process') {
        this.ctx.emitLine(`🔧 Teammate "${agent_id}" launched as process (pid ${result.pid ?? 'unknown'})`)
      }
    }

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
