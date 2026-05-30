import fs from 'fs'
import path from 'path'
import { cwd } from 'process'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool'

export class ListDirTool extends Tool {

    get name(): string {
        return 'list_dir'
    }

    get description(): string {
        return 'List the contents of a directory. Shows a file tree with names, types, and sizes.'
    }

    get inputSchemaZod() {
        return z.object({
            path: z.string().optional().describe('Absolute or relative directory path. Defaults to current working directory if omitted.'),
        })
    }

    get outputSchemaZod() {
        return z.string()
    }

    get parallelSafe(): boolean { return true }

    get isExplorationTool(): boolean { return true }

    renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
        const p = String(input.path ?? '.')
        return { label: 'List', args: Tool.shortPath(p) }
    }

    renderToolResult(output: string, isError: boolean): string[] {
        if (isError) return Tool.summarize(output, true)
        const lineCount = output.trim() ? output.trim().split('\n').length : 0
        return [`${lineCount} entr${lineCount === 1 ? 'y' : 'ies'}`]
    }

    async checkPermission(_args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
        return { action: 'continue' }
    }

    /** 将字节数转为人类可读格式 */
    private fmtSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    async execute(args: any): Promise<string> {
        const dirPath = args.path ? path.resolve(args.path) : cwd()

        const workDir = cwd()
        if (!dirPath.startsWith(workDir + path.sep) && dirPath !== workDir) {
            return `error: path "${args.path}" is outside the working directory`
        }

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true })

            // 收集信息：文件名、类型、大小
            type Entry = { name: string; type: 'file' | 'directory'; size: number | null }
            const items: Entry[] = entries.map(entry => {
                const fullPath = path.join(dirPath, entry.name)
                let size: number | null = null
                if (entry.isFile()) {
                    try { size = fs.statSync(fullPath).size } catch { /* ignore */ }
                }
                return {
                    name: entry.name,
                    type: entry.isDirectory() ? 'directory' : 'file',
                    size,
                }
            })

            // 排序：目录在前，文件在后，各自按名称排序
            items.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
                return a.name.localeCompare(b.name)
            })

            // 构建树状显示
            const lines: string[] = []
            const dirCount = items.filter(i => i.type === 'directory').length
            const fileCount = items.length - dirCount

            // 标题行：显示目录路径和条目统计
            const label = dirPath === workDir ? '.' : path.basename(dirPath)
            lines.push(`${label}/  (${items.length} entries, ${dirCount} dirs, ${fileCount} files)`)

            // 逐项输出，最后一项用 └──，其余用 ├──
            for (let i = 0; i < items.length; i++) {
                const item = items[i]
                const prefix = i === items.length - 1 ? '└── ' : '├── '
                const namePart = item.type === 'directory' ? `${item.name}/` : item.name
                const sizePart = item.size !== null ? ` (${this.fmtSize(item.size)})` : ''
                const typeHint = item.type === 'directory' ? '' : ''
                lines.push(`${prefix}${namePart}${sizePart}`)
            }

            return lines.join('\n')
        } catch (err) {
            return `error: ${err}`
        }
    }
}
