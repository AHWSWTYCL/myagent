import fs from 'fs'
import path from 'path'
import { Tool } from './tool'

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
        try {
            fs.writeFileSync(resolvedPath, updated, 'utf-8')
            return `Edited ${filePath}`
        } catch (err) {
            return `Error writing file: ${err}`
        }
    }
}
