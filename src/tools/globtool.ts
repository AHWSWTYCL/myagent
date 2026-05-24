import { globSync } from 'glob'
import { Tool } from './tool'

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
