import { execSync } from 'child_process'
import { Tool } from './tool'

export class GrepTool extends Tool {

    get name(): string {
        return 'grep'
    }

    get description(): string {
        return 'Search for a pattern in files using grep. Returns matching lines with file names and line numbers.'
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regular expression or literal string to search for' },
                path: { type: 'string', description: 'File or directory to search in (default: current working directory)' },
                recursive: { type: 'boolean', description: 'Search recursively in directories (default: true)' },
                case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default: false)' },
                include: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.ts"' },
            },
            required: ['pattern'],
        }
    }

    get parallelSafe(): boolean { return true }

    async checkPermission(_args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
        return { action: 'continue' }
    }

    async execute(args: any): Promise<string> {
        const { pattern, path: searchPath, recursive = true, case_insensitive = false, include } = args

        const flags: string[] = ['-n'] // line numbers
        if (recursive) flags.push('-r')
        if (case_insensitive) flags.push('-i')
        if (include) flags.push(`--include=${include}`)

        const target = searchPath ?? '.'
        const cmd = `grep ${flags.join(' ')} ${JSON.stringify(pattern)} ${JSON.stringify(target)}`

        try {
            const output = execSync(cmd, {
                cwd: process.cwd(),
                timeout: 10_000,
                maxBuffer: 50_000,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            })
            return output.trim() || 'No matches found.'
        } catch (err: any) {
            // grep exits with code 1 when no matches — not an error
            if (err.status === 1) return 'No matches found.'
            return `Error: ${err.stderr ?? err.message}`
        }
    }
}
