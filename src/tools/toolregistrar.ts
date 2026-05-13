import { ToolRegistry } from "./toolregistry";
import { Tool } from "./tool";

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

    getAllTools(): Tool[] {
        return this.registry.getAllTools();
    }
}