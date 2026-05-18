import { MEMORY_FILES, MemoryCategory, readCategory, writeCategory, readAllCategories } from '../memory/memory.js'
import { Tool } from './tool.js'

type MemoryAction = 'save' | 'delete' | 'list' | 'update_index'

export class MemoryTool extends Tool {

    get name(): string {
        return 'memory'
    }

    get description(): string {
        return '管理自动记忆系统。支持分类存储：profile(用户画像)、project(项目信息)、feedback(用户反馈)、reference(外部引用)、index(索引)。LLM 可根据对话内容自主判断何时记录什么信息。'
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['save', 'delete', 'list', 'update_index'],
                    description: 'save: 追加一条记忆到指定分类；delete: 从指定分类中删除匹配的记忆；list: 列出指定分类的所有记忆；update_index: 从各分类内容自动重新生成 INDEX.md',
                },
                category: {
                    type: 'string',
                    enum: ['profile', 'project', 'feedback', 'reference', 'index'],
                    description: '记忆分类：profile(用户画像/偏好)、project(项目信息/决策)、feedback(用户反馈/评价)、reference(外部引用/链接)、index(索引)',
                },
                content: {
                    type: 'string',
                    description: 'save 时填写要记录的内容（一条简洁的记忆）；delete 时填写要匹配的关键词',
                },
            },
            required: ['action', 'category'],
        }
    }

    /** 读取某分类文件中以 "- " 开头的记忆行 */
    private readCategoryLines(category: MemoryCategory): string[] {
        const raw = readCategory(category)
        return raw
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- '))
    }

    /** 将行数组写回分类文件 */
    private writeCategoryLines(category: MemoryCategory, lines: string[]): void {
        writeCategory(category, lines.join('\n') + (lines.length > 0 ? '\n' : ''))
    }

    async execute(args: { action: MemoryAction; category: MemoryCategory; content?: string }): Promise<string> {
        const { action, category, content } = args

        switch (action) {
            // ── 列出指定分类的所有记忆 ──
            case 'list': {
                const lines = this.readCategoryLines(category)
                if (lines.length === 0) {
                    return `[${category}] 当前没有任何记忆。`
                }
                return `[${category}] 当前记忆（共 ${lines.length} 条）：\n${lines.join('\n')}`
            }

            // ── 保存一条记忆到指定分类 ──
            case 'save': {
                if (!content?.trim()) {
                    return '错误：save 操作需要提供 content。'
                }
                const lines = this.readCategoryLines(category)
                const newEntry = `- ${content.trim()}`
                const duplicate = lines.find(l => l === newEntry)
                if (duplicate) {
                    return `[${category}] 已存在相同记忆，跳过：${content.trim()}`
                }
                lines.push(newEntry)
                this.writeCategoryLines(category, lines)
                return `✅ 已记录到 [${category}]：${content.trim()}`
            }

            // ── 按精确内容从指定分类中删除记忆 ──
            case 'delete': {
                if (!content?.trim()) {
                    return '错误：delete 操作需要提供要匹配的 content。'
                }
                const lines = this.readCategoryLines(category)
                const target = `- ${content.trim()}`
                const remaining = lines.filter(line => line !== target)
                const deleted = lines.length - remaining.length
                if (deleted === 0) {
                    return `[${category}] 未找到与"${content.trim()}"完全匹配的记忆条目。如需模糊删除，请先用 list 查看后提供完整内容。`
                }
                this.writeCategoryLines(category, remaining)
                return `🗑️ 已从 [${category}] 删除 ${deleted} 条记忆。`
            }

            // ── 更新 INDEX.md ──
            case 'update_index': {
                const allCats = readAllCategories()
                const indexLines: string[] = ['# 记忆索引', `最后更新: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '']

                for (const [cat, catContent] of Object.entries(allCats)) {
                    const lines = catContent
                        .split('\n')
                        .map(l => l.trim())
                        .filter(l => l.startsWith('- '))

                    // 提取前几条作为摘要
                    const summary = lines.length > 0
                        ? lines.slice(0, 3).map(l => l.replace(/^-\s*/, '')).join('; ') + (lines.length > 3 ? ` ... 等${lines.length}条` : '')
                        : '（暂无记录）'

                    indexLines.push(`## ${cat}`)
                    indexLines.push(`  摘要: ${summary}`)
                    indexLines.push(`  文件: ${cat}.md`)
                    indexLines.push('')
                }

                writeCategory('index', indexLines.join('\n'))
                return `📋 INDEX.md 已更新。`
            }

            default:
                return `错误：未知操作 "${action}"，支持的操作为 save、delete、list、update_index。`
        }
    }
}
