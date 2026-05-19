import Anthropic from "@anthropic-ai/sdk";
import { ToolRegistry } from "./toolregistry.js";
import { Tool } from "./tool.js";

export class ToolRegistrar {
    private registry: ToolRegistry;

    constructor() {
        this.registry = new ToolRegistry();
    }

    registerTool(tool: Tool) {
        this.registry.registerTool(tool);
    }

    getTool(name: string): Tool | undefined {
        return this.registry.getTool(name);
    }

    getParallelSafeNames(): Set<string> {
        return new Set(
            this.registry.getAllTools()
                .filter(t => t.parallelSafe)
                .map(t => t.name)
        )
    }

    getAllTools(): Anthropic.Tool[] {
        const tools = this.registry.getAllTools();
        return tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema
        }));
    }
}