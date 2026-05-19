import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { Command } from './command.js'
import { SkillManager } from '../skills/skillmanager.js'
import { DiskSkill, parseFrontmatter, SKILLS_DIR } from '../skills/skillloader.js'

export class SkillCommand extends Command {
  constructor(
    private skillManager: SkillManager,
    private askQuestion: (prompt: string) => Promise<string>,
  ) {
    super()
  }

  get name(): string {
    return 'skill'
  }

  get description(): string {
    return '管理自定义 skill（add/list/delete/modify）'
  }

  get usage(): string {
    return '/skill <add|list|delete|modify> [name]'
  }

  async execute(args: string[]): Promise<void> {
    const subcommand = args[0]
    switch (subcommand) {
      case 'add':
        await this.handleAdd()
        break
      case 'list':
        await this.handleList()
        break
      case 'delete':
        await this.handleDelete(args)
        break
      case 'modify':
        await this.handleModify(args)
        break
      default:
        console.log(`用法：${this.usage}`)
    }
  }

  private async handleAdd(): Promise<void> {
    const name = await this.askQuestion('skill 名称: ')

    if (!/^[a-zA-Z0-9-]+$/.test(name)) {
      console.log('错误：skill 名称只允许字母、数字和连字符')
      return
    }

    const existing = this.skillManager.listSkills().map(s => s.name)
    if (existing.includes(name)) {
      console.log(`错误：skill "${name}" 已存在`)
      return
    }

    const description = await this.askQuestion('skill 描述: ')

    const template = `---
name: ${name}
description: ${description}
---

在这里写你的 skill prompt...
`

    const tmpFile = `/tmp/myagent-skill-${name}.md`
    fs.writeFileSync(tmpFile, template, 'utf-8')

    const editor = process.env.EDITOR ?? 'vi'
    try {
      execSync(`"${editor}" "${tmpFile}"`, { stdio: 'inherit' })
    } catch (err) {
      console.log(`错误：编辑器退出异常：${err}`)
      fs.unlinkSync(tmpFile)
      return
    }

    const content = fs.readFileSync(tmpFile, 'utf-8')

    let parsed: { name: string; description: string; prompt: string }
    try {
      parsed = parseFrontmatter(content)
    } catch (err) {
      console.log(`错误：解析 skill 文件失败：${err}`)
      fs.unlinkSync(tmpFile)
      return
    }

    fs.mkdirSync(SKILLS_DIR, { recursive: true })
    const destPath = path.join(SKILLS_DIR, `${parsed.name}.md`)
    fs.writeFileSync(destPath, content, 'utf-8')

    await this.skillManager.loadFromDisk()

    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }

    console.log(`skill "${parsed.name}" 已添加`)
  }

  private async handleList(): Promise<void> {
    const skills = this.skillManager.listSkills()
    const activeNames = new Set(this.skillManager.getActiveSkills().map(s => s.name))

    console.log(`可用 skill（共 ${skills.length} 个）：`)
    for (const skill of skills) {
      const source = skill instanceof DiskSkill ? '[自定义]' : '[内置]'
      const status = activeNames.has(skill.name) ? '[已激活]' : '[未激活]'
      console.log(`- ${skill.name} ${source} ${status}：${skill.description}`)
    }
  }

  private async handleDelete(args: string[]): Promise<void> {
    const name = args[1]
    if (!name) {
      console.log(`用法：/skill delete <name>`)
      return
    }

    if (this.skillManager.isBuiltin(name)) {
      console.log(`错误：内置 skill "${name}" 不可删除`)
      return
    }

    const filePath = path.join(SKILLS_DIR, `${name}.md`)
    if (!fs.existsSync(filePath)) {
      console.log(`错误：skill "${name}" 不存在`)
      return
    }

    fs.unlinkSync(filePath)
    await this.skillManager.loadFromDisk()
    console.log(`skill "${name}" 已删除`)
  }

  private async handleModify(args: string[]): Promise<void> {
    const name = args[1]
    if (!name) {
      console.log(`用法：/skill modify <name>`)
      return
    }

    if (this.skillManager.isBuiltin(name)) {
      console.log(`错误：内置 skill "${name}" 不可修改`)
      return
    }

    const filePath = path.join(SKILLS_DIR, `${name}.md`)
    if (!fs.existsSync(filePath)) {
      console.log(`错误：skill "${name}" 不存在`)
      return
    }

    const editor = process.env.EDITOR ?? 'vi'
    try {
      execSync(`"${editor}" "${filePath}"`, { stdio: 'inherit' })
    } catch (err) {
      console.log(`错误：编辑器退出异常：${err}`)
      return
    }

    await this.skillManager.loadFromDisk()
    console.log(`skill "${name}" 已更新`)
  }
}
