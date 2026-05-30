import { Skill } from './skill.js'
import { loadSkillsFromDisk } from './skillloader.js'
import { attachmentQueue } from '../attachment/queue.js'
import { SkillAttachment } from '../attachment/skill.js'

export class SkillManager {
  private skills: Map<string, Skill> = new Map()
  private activeSkills: Set<string> = new Set()
  private builtinSkills: Map<string, Skill> = new Map()

  register(skill: Skill): void {
    this.skills.set(skill.name, skill)
  }

  registerBuiltin(skill: Skill): void {
    this.builtinSkills.set(skill.name, skill)
    this.skills.set(skill.name, skill)
  }

  isBuiltin(name: string): boolean {
    return this.builtinSkills.has(name)
  }

  async loadFromDisk(): Promise<void> {
    // 清除所有非内置 skill
    for (const name of this.skills.keys()) {
      if (!this.builtinSkills.has(name)) {
        this.skills.delete(name)
        this.activeSkills.delete(name)
      }
    }

    const diskSkills = await loadSkillsFromDisk()
    for (const skill of diskSkills) {
      this.register(skill)
    }

    console.log(`[skillManager] 从磁盘加载了 ${diskSkills.length} 个自定义 skill`)
  }

  activate(name: string): string {
    if (!this.skills.has(name)) {
      return `错误：skill "${name}" 不存在。可用的 skill：${[...this.skills.keys()].join(', ') || '（无）'}`
    }
    this.activeSkills.add(name)
    attachmentQueue.enqueue(new SkillAttachment(name, 'activated'))
    return `已激活 skill：${name}。${this.skills.get(name)!.description}`
  }

  deactivate(name: string): string {
    if (!this.activeSkills.has(name)) {
      return `skill "${name}" 当前未激活。`
    }
    this.activeSkills.delete(name)
    attachmentQueue.enqueue(new SkillAttachment(name, 'deactivated'))
    return `已停用 skill：${name}。`
  }

  listSkills(): Skill[] {
    return [...this.skills.values()]
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  getActiveSkills(): Skill[] {
    return [...this.activeSkills].map(name => this.skills.get(name)!)
  }

  buildPromptFragment(): string {
    const active = this.getActiveSkills()
    if (active.length === 0) return ''
    const fragment = active.map(s => s.prompt).join('\n\n')
    console.log(`[skillManager] 构建了技能提示片段，包含 ${active.length} 个技能。`, fragment)
    return `\n\n## 激活的技能\n${fragment}`
  }
}
