import { Tool } from './tool.js'
import { SkillManager } from '../skills/skillmanager.js'

type SkillAction = 'activate' | 'deactivate' | 'list'

export class UseSkillTool extends Tool {
  private skillManager: SkillManager

  constructor(skillManager: SkillManager) {
    super()
    this.skillManager = skillManager
  }

  get name(): string {
    return 'use_skill'
  }

  get description(): string {
    return '激活或停用一个 skill。skill 激活后会影响 LLM 的后续行为和回答风格。使用 list 查看所有可用 skill 及其当前状态。'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['activate', 'deactivate', 'list'],
          description: 'activate: 激活指定 skill；deactivate: 停用指定 skill；list: 列出所有 skill 及激活状态',
        },
        skill_name: {
          type: 'string',
          description: 'activate 或 deactivate 时必填，指定 skill 的名称',
        },
      },
      required: ['action'],
    }
  }

  async execute(args: { action: SkillAction; skill_name?: string }): Promise<string> {
    const { action, skill_name } = args

    switch (action) {
      case 'activate': {
        if (!skill_name?.trim()) {
          return '错误：activate 操作需要提供 skill_name。'
        }
        return this.skillManager.activate(skill_name.trim())
      }

      case 'deactivate': {
        if (!skill_name?.trim()) {
          return '错误：deactivate 操作需要提供 skill_name。'
        }
        return this.skillManager.deactivate(skill_name.trim())
      }

      case 'list': {
        const all = this.skillManager.listSkills()
        if (all.length === 0) {
          return '当前没有注册任何 skill。'
        }
        const active = new Set(this.skillManager.getActiveSkills().map(s => s.name))
        const lines = all.map(s => {
          const status = active.has(s.name) ? '✅ 已激活' : '⬜ 未激活'
          return `- ${s.name} [${status}]：${s.description}`
        })
        return `可用 skill（共 ${all.length} 个）：\n${lines.join('\n')}`
      }

      default:
        return `未知操作：${action}，支持的操作为 activate、deactivate、list。`
    }
  }
}
