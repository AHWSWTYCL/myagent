import fs from 'fs'
import { Tool } from "./tool";

export class ReadTool extends Tool {

    get name(): string {
        return 'read_file';
    }

    get description(): string {
        return 'Read a file from the filesystem and return its contents';
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object' as const,
            properties: {
                path: { type: 'string', description: 'Absolute or relative file path' },
            },
            required: ['path'],
        }
    }

    get output_schema(): object {
        return {
            type: 'object' as const,
            properties: {
                content: { type: 'string', description: 'Contents of the file' },
            },
            required: ['content'],
        }
    }

    execute(args: any): string {
        const path = args.path;
        try {
            const content = fs.readFileSync(path, 'utf-8');
            return content;
        } catch (err) {
            return `Error reading file at ${path}: ${err}`;
        }
    }
}    