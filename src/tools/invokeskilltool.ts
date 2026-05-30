import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { SkillManager } from '../skills/skillmanager.js'

/**
 * 让模型按需调用已注册技能的 tool。
 * 模型看到所有技能的 name + description 后，自行判断何时需要调用。
 * 调用后技能 content 作为 tool result 返回，模型可据此行为。
 *
 * 设计参考 Claude Code 的 SkillTool：技能是"按需使用"而非"注入系统提示"。
 */
export class InvokeSkillTool extends Tool {
  private skillManager: SkillManager

  constructor(skillManager: SkillManager) {
    super()
    this.skillManager = skillManager
  }

  get name(): string {
    return 'invoke_skill'
  }

  get description(): string {
    const all = this.skillManager.listSkills()
    if (all.length === 0) {
      return '当前没有可用的技能。'
    }
    const listing = all
      .map(s => `"${s.name}": ${s.description}`)
      .join('；')
    return `调用一个已注册的专业技能来获得领域知识和行为指导。可用的技能：${listing}。当用户的任务涉及以上领域时，先调用对应技能获取指导后再回答。调用时不传 skill_name 可查看技能列表。`
  }

  get inputSchemaZod() {
    return z.object({
      skill_name: z.string().optional().describe('要调用的技能名称。不传或为空时返回所有可用技能列表。'),
    })
  }

  get outputSchemaZod() {
    return z.string()
  }

  get parallelSafe(): boolean {
    return true
  }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    return { label: 'InvokeSkill', args: String(input.skill_name ?? '') }
  }

  async execute(args: { skill_name?: string }): Promise<string> {
    const name = args?.skill_name?.trim()

    // 不带参数 → 返回技能列表
    if (!name) {
      const all = this.skillManager.listSkills()
      if (all.length === 0) {
        return '当前没有可用的技能。'
      }
      return `可用技能（共 ${all.length} 个）：\n${all.map(s => `- ${s.name}：${s.description}`).join('\n')}`
    }

    // 按名查找
    const skill = this.skillManager.getSkill(name)
    if (!skill) {
      const all = this.skillManager.listSkills()
      const names = all.map(s => `"${s.name}"`).join('、')
      return `错误：未找到技能"${name}"。可用技能：${names}`
    }

    return `## 技能：${skill.name}\n\n${skill.prompt}`
  }
}
