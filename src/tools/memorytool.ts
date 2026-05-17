import fs from 'fs'
import { MEMORY_FILE_PATH } from '../memory/memory.js'
import { Tool } from './tool.js'

type MemoryAction = 'save' | 'delete' | 'list'

export class MemoryTool extends Tool {

    get name(): string {
        return 'memory'
    }

    get description(): string {
        return '管理用户的长期记忆。支持三种操作：save（保存一条记忆）、delete（删除匹配的记忆）、list（列出所有记忆）。当用户明确要求记住或忘记某件事时使用此工具。'
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['save', 'delete', 'list'],
                    description: 'save: 追加一条新记忆；delete: 删除包含指定内容的记忆条目；list: 列出所有当前记忆',
                },
                content: {
                    type: 'string',
                    description: 'save 时为要记录的内容；delete 时为要匹配删除的关键词或内容片段；list 时可省略',
                },
            },
            required: ['action'],
        }
    }

    private readMemories(): string[] {
        if (!fs.existsSync(MEMORY_FILE_PATH)) {
            return []
        }
        const raw = fs.readFileSync(MEMORY_FILE_PATH, 'utf-8')
        return raw
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- '))
    }

    private writeMemories(memories: string[]): void {
        const dir = MEMORY_FILE_PATH.replace(/\/[^/]+$/, '')
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(MEMORY_FILE_PATH, memories.join('\n') + (memories.length > 0 ? '\n' : ''))
    }

    async execute(args: { action: MemoryAction; content?: string }): Promise<string> {
        const { action, content } = args

        switch (action) {
            case 'list': {
                const memories = this.readMemories()
                if (memories.length === 0) {
                    return '当前没有任何记忆。'
                }
                return `当前记忆（共 ${memories.length} 条）：\n${memories.join('\n')}`
            }

            case 'save': {
                if (!content?.trim()) {
                    return '错误：save 操作需要提供 content。'
                }
                const memories = this.readMemories()
                const newEntry = `- ${content.trim()}`
                memories.push(newEntry)
                this.writeMemories(memories)
                return `已记住：${content.trim()}`
            }

            case 'delete': {
                if (!content?.trim()) {
                    return '错误：delete 操作需要提供要匹配的 content。'
                }
                const memories = this.readMemories()
                const keyword = content.trim().toLowerCase()
                const before = memories.length
                const remaining = memories.filter(
                    line => !line.toLowerCase().includes(keyword)
                )
                const deleted = before - remaining.length
                if (deleted === 0) {
                    return `未找到包含"${content.trim()}"的记忆条目。`
                }
                this.writeMemories(remaining)
                return `已删除 ${deleted} 条包含"${content.trim()}"的记忆。`
            }

            default:
                return `未知操作：${action}，支持的操作为 save、delete、list。`
        }
    }
}
