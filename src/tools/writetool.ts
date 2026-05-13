import fs from 'fs'
import { Tool } from "./tool";

export class WriteTool extends Tool {

    get name(): string {
        return 'write_file';
    }

    get description(): string {
        return 'Useful for when you need to write a file. Input should be a file path and content.';
    }

    get input_schema(): object {
        return {
            type: 'object' as const,
            properties: {
                type: 'object' as const,
                properties: {
                    path: { type: 'string', description: 'Absolute or relative file path' },
                    content: { type: 'string', description: 'Content to write' },
                },
                required: ['path', 'content'],
            }
        }
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

    execute(args: any): string {
        const path = args.path;
        const content = args.content;
        try {
            fs.writeFileSync(path, content);
            return JSON.stringify({ success: true, message: `Wrote ${content.length} bytes to ${path}` });
        } catch (err) {
            return JSON.stringify({ success: false, message: `Error writing file at ${path}: ${err}` });
        }
    }
}   