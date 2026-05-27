import * as fs from 'fs'
import * as path from 'path'
import { Tool, type ToolRenderHeader } from './tool.js'
import { SkillManager } from '../skills/skillmanager.js'
import { SKILLS_DIR, parseFrontmatter } from '../skills/skillloader.js'

type SkillWriteAction = 'write' | 'list' | 'delete'

export class SkillWriteTool extends Tool {
  constructor(private skillManager: SkillManager) {
    super()
  }

  get name(): string {
    return 'skill_write'
  }

  get description(): string {
    return '管理 skill 文件（~/.myagent/skills/）。write: 写入或覆盖一个 skill；list: 列出所有 skill 的名称、描述和完整 prompt；delete: 删除一个自定义 skill。仅用于 Self-Improving Agent 复盘阶段。'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'list', 'delete'],
          description: 'write: 创建或覆盖 skill 文件；list: 列出所有 skill（含完整内容）；delete: 删除指定 skill',
        },
        name: {
          type: 'string',
          description: 'skill 名称（只允许字母、数字、连字符）。write 和 delete 时必填。',
        },
        description: {
          type: 'string',
          description: 'skill 的一句话描述。write 时必填。',
        },
        prompt: {
          type: 'string',
          description: 'skill 的完整 prompt 内容（frontmatter 后的正文）。write 时必填。',
        },
      },
      required: ['action'],
    }
  }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    return { label: 'SkillWrite', args: String(input.name ?? '') }
  }

  async execute(args: {
    action: SkillWriteAction
    name?: string
    description?: string
    prompt?: string
  }): Promise<string> {
    const { action, name, description, prompt } = args

    switch (action) {
      case 'list': {
        if (!fs.existsSync(SKILLS_DIR)) {
          return '当前没有任何自定义 skill。'
        }
        const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'))
        if (files.length === 0) {
          return '当前没有任何自定义 skill。'
        }
        const entries: string[] = []
        for (const file of files) {
          const content = fs.readFileSync(path.join(SKILLS_DIR, file), 'utf-8')
          try {
            const parsed = parseFrontmatter(content)
            entries.push(`### ${parsed.name}\n描述: ${parsed.description}\n\n${parsed.prompt}`)
          } catch {
            entries.push(`### ${file}（格式错误，跳过）`)
          }
        }
        return `自定义 skill（共 ${files.length} 个）：\n\n${entries.join('\n\n---\n\n')}`
      }

      case 'write': {
        if (!name?.trim()) return '错误：write 操作需要提供 name。'
        if (!description?.trim()) return '错误：write 操作需要提供 description。'
        if (!prompt?.trim()) return '错误：write 操作需要提供 prompt。'

        if (!/^[a-zA-Z0-9-]+$/.test(name)) {
          return '错误：skill 名称只允许字母、数字和连字符。'
        }

        const fileContent = `---\nname: ${name}\ndescription: ${description}\n---\n\n${prompt.trim()}\n`

        // 验证格式可解析
        try {
          parseFrontmatter(fileContent)
        } catch (err) {
          return `错误：生成的 skill 文件格式无效：${err}`
        }

        fs.mkdirSync(SKILLS_DIR, { recursive: true })
        const destPath = path.join(SKILLS_DIR, `${name}.md`)
        const isUpdate = fs.existsSync(destPath)
        fs.writeFileSync(destPath, fileContent, 'utf-8')

        await this.skillManager.loadFromDisk()

        return isUpdate
          ? `✅ skill "${name}" 已更新并热加载。`
          : `✅ skill "${name}" 已创建并热加载。`
      }

      case 'delete': {
        if (!name?.trim()) return '错误：delete 操作需要提供 name。'

        if (this.skillManager.isBuiltin(name)) {
          return `错误：内置 skill "${name}" 不可删除。`
        }

        const filePath = path.join(SKILLS_DIR, `${name}.md`)
        if (!fs.existsSync(filePath)) {
          return `错误：skill "${name}" 不存在。`
        }

        fs.unlinkSync(filePath)
        await this.skillManager.loadFromDisk()
        return `🗑️ skill "${name}" 已删除。`
      }

      default:
        return `错误：未知操作 "${action}"，支持 write、list、delete。`
    }
  }
}
