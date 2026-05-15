import fs from 'fs'
import path from 'path'
import { cwd } from 'process'
import { Tool } from './tool'

export class ListDirTool extends Tool {

    get name(): string {
        return 'list_dir'
    }

    get description(): string {
        return 'List the contents of a directory. Returns file names, types (file/directory), and sizes.'
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or relative directory path. Defaults to current working directory if omitted.' },
            },
            required: [],
        }
    }

    execute(args: any): string {
        const dirPath = args.path ? path.resolve(args.path) : cwd()

        const workDir = cwd()
        if (!dirPath.startsWith(workDir + path.sep) && dirPath !== workDir) {
            return JSON.stringify({ error: `Path ${args.path} is outside the working directory` })
        }

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true })
            const result = entries.map(entry => {
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
            return JSON.stringify(result, null, 2)
        } catch (err) {
            return JSON.stringify({ error: `Error listing directory ${dirPath}: ${err}` })
        }
    }
}
