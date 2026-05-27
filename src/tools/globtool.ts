import { globSync } from 'glob'
import { Tool, type ToolRenderHeader } from './tool'

export class GlobTool extends Tool {

    get name(): string {
        return 'glob'
    }

    get description(): string {
        return 'Find files matching a glob pattern. Returns a list of matching file paths.'
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
                cwd: { type: 'string', description: 'Directory to search from (default: current working directory)' },
            },
            required: ['pattern'],
        }
    }

    get parallelSafe(): boolean { return true }

    get isExplorationTool(): boolean { return true }

    renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
        return { label: 'Glob', args: String(input.pattern ?? '') }
    }

    renderToolResult(output: string, isError: boolean): string[] {
        if (isError) return Tool.summarize(output, true)
        const lines = output.trim() ? output.trim().split('\n') : []
        return lines.length === 0
            ? ['No matches']
            : [`Found ${lines.length} file${lines.length === 1 ? '' : 's'}`]
    }

    async checkPermission(_args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
        return { action: 'continue' }
    }

    async execute(args: any): Promise<string> {
        const { pattern, cwd } = args
        try {
            const matches = globSync(pattern, { cwd: cwd ?? process.cwd(), nodir: false })
            if (matches.length === 0) return 'No files matched.'
            return matches.join('\n')
        } catch (err) {
            return `Error: ${err}`
        }
    }
}
