import fs from 'fs'
import path from 'path'
import os from 'os'
import { cwd } from 'process'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from "./tool";
import { getLSPManager } from '../lsp/index.js'
import { fileStateCache } from '../utils/fileStateCache.js'

// 系统敏感路径前缀——写这些路径直接阻断
const SENSITIVE_PATH_PREFIXES = [
    '/etc',
    '/sys',
    '/proc',
    '/dev',
    '/boot',
    '/var/log',
    path.join(os.homedir(), '.ssh'),
    path.join(os.homedir(), '.aws'),
    path.join(os.homedir(), '.config'),
    path.join(os.homedir(), '.gnupg'),
]

export class WriteTool extends Tool {

    /**
     * 写入完成后的回调。bootstrap.ts 注入，用于通知 VSCode 展示 diff。
     * fire-and-forget — 不阻塞 execute() 返回。
     */
    onFileChanged?: (filePath: string, oldContent: string, newContent: string) => void

    /**
     * 写入前的交互式审批回调。bootstrap.ts 注入。
     * 在 auto mode 下返回 { action: 'skip' }，manual mode 下等待用户操作。
     */
    onBeforeEdit?: (
        filePath: string, oldContent: string, newContent: string, signal?: AbortSignal
    ) => Promise<{ action: 'skip' | 'accepted' | 'rejected' | 'modified'; newContent?: string }>

    get name(): string {
        return 'write_file';
    }

    get description(): string {
        return 'Useful for when you need to write a file. Input should be a file path and content.';
    }

    get inputSchemaZod() {
        return z.object({
            path: z.string().describe('Absolute or relative file path'),
            content: z.string().describe('Content to write'),
        })
    }

    get outputSchemaZod() {
        return z.string()
    }

    renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
        return { label: 'Write', args: Tool.shortPath(String(input.path ?? '')) }
    }

    renderToolResult(output: string, isError: boolean, input?: Record<string, unknown>): string[] {
        if (isError) return Tool.summarize(output, true)
        const content = String(input?.content ?? '')
        const lineCount = content ? content.split('\n').length : 0
        return [`Wrote ${lineCount} line${lineCount === 1 ? '' : 's'}`]
    }

    async checkPermission(args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
        const filePath = (args.path ?? '') as string
        if (!filePath.trim()) return { action: 'defer' }

        const resolvedPath = path.resolve(filePath)

        // 系统敏感路径 → 阻断
        for (const prefix of SENSITIVE_PATH_PREFIXES) {
            if (resolvedPath === prefix || resolvedPath.startsWith(prefix + path.sep)) {
                return { action: 'block', reason: `Writing to sensitive path '${prefix}' is not allowed` }
            }
        }

        // 项目内文件 → 让上层决定
        return { action: 'defer' }
    }

    get output_schema(): object {
        return {
            type: 'object' as const,
            properties: {
                success: { type: 'boolean', description: 'Whether the file was written successfully' },
                message: { type: 'string', description: 'Error message if the file was not written successfully' },
            },
            required: ['success'],
        }
    }

    async execute(args: any, signal?: AbortSignal): Promise<string> {
        const filePath = args.path;
        let content = args.content;

        const resolvedPath = path.resolve(filePath);
        const workDir = cwd();
        if (!resolvedPath.startsWith(workDir + path.sep) && resolvedPath !== workDir) {
            return JSON.stringify({ success: false, message: `Path ${filePath} is outside the working directory` });
        }

        // 写前读取旧内容（用于 diff 回调）
        let oldContent = ''
        try {
            oldContent = fs.readFileSync(resolvedPath, 'utf-8')
        } catch {
            // 文件不存在（新建），oldContent 保持 ''
        }

        // ── 交互式审批（VSCode 可用时阻塞等待用户操作）─────────────────
        if (this.onBeforeEdit) {
            const result = await this.onBeforeEdit(resolvedPath, oldContent, content, signal)
            if (result.action === 'rejected') {
                return JSON.stringify({ success: false, message: 'Write rejected by user' })
            }
            if (result.action === 'modified' && result.newContent !== undefined) {
                content = result.newContent
            }
            // 'accepted' 或 'skip'：继续执行
        }

        try {
            fs.writeFileSync(resolvedPath, content);

            // 更新文件缓存（供后续 edit_file 使用）
            try {
              fileStateCache.set(resolvedPath, {
                content,
                timestamp: fs.statSync(resolvedPath).mtimeMs,
              })
            } catch { /* ignore */ }

            // LSP 文件同步
            const lsp = getLSPManager()
            if (lsp) {
              lsp.changeFile(resolvedPath, content).catch(() => {})
              lsp.saveFile(resolvedPath).catch(() => {})
            }

            // 通知 VSCode 展示 diff（fire-and-forget）
            if (this.onFileChanged) {
              this.onFileChanged(resolvedPath, oldContent, content)
            }

            return JSON.stringify({ success: true, message: `Wrote ${content.length} bytes to ${resolvedPath}` });
        } catch (err) {
            return JSON.stringify({ success: false, message: `Error writing file at ${resolvedPath}: ${err}` });
        }
    }
}   