import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Skill } from './skill.js'

export const SKILLS_DIR = path.join(os.homedir(), '.myagent', 'skills')

export class DiskSkill extends Skill {
  constructor(
    private _name: string,
    private _description: string,
    private _prompt: string,
  ) {
    super()
  }

  get name(): string {
    return this._name
  }

  get description(): string {
    return this._description
  }

  get prompt(): string {
    return this._prompt
  }
}

export function parseFrontmatter(content: string): { name: string; description: string; prompt: string } {
  if (!content.startsWith('---')) {
    throw new Error('文件格式错误：缺少 frontmatter（应以 --- 开头）')
  }

  const firstEnd = content.indexOf('\n')
  const rest = content.slice(firstEnd + 1)
  const secondDash = rest.indexOf('\n---')

  if (secondDash === -1) {
    throw new Error('文件格式错误：找不到 frontmatter 结束标记 ---')
  }

  const frontmatterBlock = rest.slice(0, secondDash)
  const promptContent = rest.slice(secondDash + 4).trim() // skip '\n---'

  let name = ''
  let description = ''

  for (const line of frontmatterBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key === 'name') name = value
    else if (key === 'description') description = value
  }

  if (!name) throw new Error('frontmatter 缺少 name 字段')
  if (!description) throw new Error('frontmatter 缺少 description 字段')

  return { name, description, prompt: promptContent }
}

export async function loadSkillsFromDisk(): Promise<Skill[]> {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
    return []
  }

  const entries = fs.readdirSync(SKILLS_DIR)
  const mdFiles = entries.filter(f => f.endsWith('.md'))

  const skills: Skill[] = []
  for (const file of mdFiles) {
    const filePath = path.join(SKILLS_DIR, file)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const { name, description, prompt } = parseFrontmatter(content)
      skills.push(new DiskSkill(name, description, prompt))
    } catch (err) {
      console.warn(`[skillloader] 跳过文件 ${file}：${err}`)
    }
  }

  return skills
}
