import { Tool } from "./tool";

export class ToolRegistry {
    private tools: Map<string, Tool> = new Map();

    registerTool(tool: Tool) {
        this.tools.set(tool.name, tool);
    }

    /** Remove a tool by name. Returns true if it existed. */
    removeTool(name: string): boolean {
        return this.tools.delete(name);
    }

    getTool(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    getAllTools(): Tool[] {
        return Array.from(this.tools.values());
    }
}