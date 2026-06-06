import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { TeamManager } from '../team/team.js'

/**
 * CreateTeamTool — 创建一个命名 team（协作组"房间"）。
 *
 * 全局工具，主 agent 或 leader 都可调用。
 * 创建后，team 目录 `~/.myagent/teams/<team_name>/` 会有一个 team.json manifest。
 * teammate 可通过 start_teammate 或 agent tool 的 team_name 参数加入。
 */
export class CreateTeamTool extends Tool {
  constructor() {
    super()
  }

  get name(): string { return 'create_team' }

  get description(): string {
    return [
      'Create a named team (a coordination "room" for leader + teammates).',
      'A team is a file-based grouping stored at ~/.myagent/teams/<team_name>/team.json.',
      'After creating a team, teammate workers can be added via start_teammate (with team_name parameter) or by calling agent(agent="teammate", team_name="...", ...).',
      'The team manifest tracks: name, leader_id, description, and member list.',
      'Use list_team to see members, disband_team to clean up.',
    ].join(' ')
  }

  get inputSchemaZod() {
    const nameRe = /^[a-zA-Z0-9_\-.]{1,64}$/
    return z.object({
      team_name: z.string().regex(nameRe, 'Team name must be 1-64 chars, alphanumeric + _ - .').describe('Unique team name (1-64 chars, alphanumeric + _ - .)'),
      description: z.string().optional().describe('Optional description of what this team does'),
      leader_id: z.string().optional().describe('Leader agent id. If omitted, defaults to the calling agent\'s id. Typically "leader" or a custom id.'),
    })
  }

  get outputSchemaZod() { return z.string() }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    return {
      label: 'CreateTeam',
      args: `${input.team_name ?? '?'}`,
    }
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: {
    team_name: string
    description?: string
    leader_id?: string
  }): Promise<string> {
    const { team_name, description, leader_id } = args

    if (TeamManager.exists(team_name)) {
      const existing = TeamManager.get(team_name)!
      return `Team "${team_name}" already exists (created ${existing.created_at}, ${existing.members.length} members). Use it directly or disband first.`
    }

    const manifest = TeamManager.create({
      name: team_name,
      leader_id,
      description,
    })

    const descLine = description ? `\ndescription: ${description}` : ''
    return [
      `Team "${team_name}" created.`,
      `Path: ~/.myagent/teams/${team_name}/team.json`,
      `Leader: ${leader_id ?? '(not set)'}`,
      descLine,
      '',
      'Next: spawn teammates with start_teammate and team_name parameter, or use agent(agent="teammate", team_name="' + team_name + '", ...).',
    ].filter(Boolean).join('\n')
  }
}
