import fs from 'fs'
import path from 'path'
import { cwd } from 'process'
import { Tool } from "./tool";

export class WriteTool extends Tool {

    get name(): string {
        return 'write_file';
    }

    get description(): string {
        return 'Useful for when you need to write a file. Input should be a file path and content.';
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute or relative file path' },
                content: { type: 'string', description: 'Content to write' },
            },
            required: ['path', 'content'],
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
        const filePath = args.path;
        const content = args.content;

        const resolvedPath = path.resolve(filePath);
        const workDir = cwd();
        if (!resolvedPath.startsWith(workDir + path.sep) && resolvedPath !== workDir) {
            return JSON.stringify({ success: false, message: `Path ${filePath} is outside the working directory` });
        }

        try {
            fs.writeFileSync(resolvedPath, content);
            return JSON.stringify({ success: true, message: `Wrote ${content.length} bytes to ${resolvedPath}` });
        } catch (err) {
            return JSON.stringify({ success: false, message: `Error writing file at ${resolvedPath}: ${err}` });
        }
    }
}   