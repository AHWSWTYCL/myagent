import fs from 'fs'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from "./tool";

export class ReadTool extends Tool {

    get name(): string {
        return 'read_file';
    }

    get description(): string {
        return 'Read a file from the filesystem and return its contents';
    }

    get inputSchemaZod() {
        return z.object({
            path: z.string().describe('Absolute or relative file path'),
        })
    }

    get outputSchemaZod() {
        return z.string()
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

    get parallelSafe(): boolean { return true }

    get isExplorationTool(): boolean { return true }

    renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
        return { label: 'Read', args: Tool.shortPath(String(input.path ?? '')) }
    }

    renderToolResult(output: string, isError: boolean): string[] {
        if (isError) return Tool.summarize(output, true)
        const lineCount = output.split('\n').length
        return [`Read ${lineCount} line${lineCount === 1 ? '' : 's'}`]
    }

    async checkPermission(_args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
        return { action: 'continue' }
    }

    async execute(args: any): Promise<string> {
        const path = args.path;
        try {
            const content = fs.readFileSync(path, 'utf-8');
            return content;
        } catch (err) {
            return `Error reading file at ${path}: ${err}`;
        }
    }
}    