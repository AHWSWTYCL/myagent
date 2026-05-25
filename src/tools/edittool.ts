import fs from 'fs'
import path from 'path'
import { structuredPatch } from 'diff'
import { Tool } from './tool'

/** 一条 diff 行，供 TUI 渲染 */
export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  content: string          // 行内容（不含 +/- 前缀）
  oldLine: number | null   // 旧文件行号（remove/context）
  newLine: number | null   // 新文件行号（add/context）
}

/** EditTool 执行结果中解析出的 diff 信息 */
export interface EditDiffResult {
  filePath: string
  lines: DiffLine[]
  additions: number
  removals: number
}

export class EditTool extends Tool {

    get name(): string {
        return 'edit_file'
    }

    get description(): string {
        return 'Replace an exact string in a file with new content. The old_string must match exactly (including whitespace and indentation). Fails if old_string is not found or is ambiguous (appears more than once).'
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or relative file path' },
                old_string: { type: 'string', description: 'Exact string to find and replace' },
                new_string: { type: 'string', description: 'Replacement string' },
            },
            required: ['path', 'old_string', 'new_string'],
        }
    }

    async execute(args: any): Promise<string> {
        const { path: filePath, old_string, new_string } = args
        const resolvedPath = path.resolve(filePath)

        let content: string
        try {
            content = fs.readFileSync(resolvedPath, 'utf-8')
        } catch (err) {
            return `Error reading file: ${err}`
        }

        const count = content.split(old_string).length - 1
        if (count === 0) return `Error: old_string not found in ${filePath}`
        if (count > 1) return `Error: old_string appears ${count} times — provide more context to make it unique`

        const updated = content.replace(old_string, new_string)

        // ── 计算 diff ────────────────────────────────────────────────
        const patch = structuredPatch(
            filePath, filePath,
            content, updated,
            undefined, undefined,
            { context: 3 },
        )

        // 把 structuredPatch 转成 DiffLine[]
        const diffLines: DiffLine[] = []
        for (const hunk of patch.hunks) {
            let oldLine = hunk.oldStart
            let newLine = hunk.newStart
            for (const line of hunk.lines) {
                const ch = line[0]
                const text = line.slice(1)
                if (ch === ' ') {
                    diffLines.push({ type: 'context', content: text, oldLine, newLine })
                    oldLine++
                    newLine++
                } else if (ch === '-') {
                    diffLines.push({ type: 'remove', content: text, oldLine, newLine: null })
                    oldLine++
                } else if (ch === '+') {
                    diffLines.push({ type: 'add', content: text, oldLine: null, newLine })
                    newLine++
                }
            }
        }

        const additions = diffLines.filter(l => l.type === 'add').length
        const removals = diffLines.filter(l => l.type === 'remove').length

        // ── 写文件 ────────────────────────────────────────────────────
        try {
            fs.writeFileSync(resolvedPath, updated, 'utf-8')
        } catch (err) {
            return `Error writing file: ${err}`
        }

        // 返回结构化数据 + 人类可读摘要
        const diffData: EditDiffResult = { filePath, lines: diffLines, additions, removals }
        const summary = `Edited ${filePath} (${additions} added, ${removals} removed)`
        return JSON.stringify({ summary, diff: diffData })
    }
}
