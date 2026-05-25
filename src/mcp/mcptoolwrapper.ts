/**
 * MCP Tool/Resource/Prompt → myagent Tool 包装器。
 *
 * 将 MCP Server 暴露的工具/资源/Prompts 包装为 Tool 子类实例，
 * 使其可以注册到 ToolRegistrar 并被 LLM 调用。
 */

import { Tool, type ToolPermissionResult } from '../tools/tool.js'
import type { MCPTool, MCPResource, MCPPrompt } from './mcpprotocol.js'
import type { MCPServer } from './mcpserver.js'

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 从资源 URI 中提取一个可读的名称。
 * 示例：
 *   "db://users/schema" → "users_schema"
 *   "file:///workspace/config.json" → "workspace_config.json"
 *   "https://example.com/api/users" → "api_users"
 */
function resourceNameFromUri(uri: string): string {
  // 去掉协议前缀
  let name = uri.replace(/^[a-z]+:\/?\/?/i, '')
  // 替换路径分隔符和特殊字符为下划线
  name = name.replace(/[\/\.:@?&=#%]/g, '_')
  // 去掉首尾下划线
  name = name.replace(/^_+|_+$/g, '')
  // 合并连续下划线
  name = name.replace(/_+/g, '_')
  return name || 'resource'
}

/**
 * 将 MCP Prompt 的 arguments 定义转换为 JSON Schema。
 */
function promptArgsToSchema(
  args?: Array<{ name: string; description?: string; required?: boolean }>,
): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
  const schema: { type: 'object'; properties: Record<string, unknown>; required: string[] } = {
    type: 'object',
    properties: {},
    required: [],
  }

  if (!args || args.length === 0) return schema

  for (const arg of args) {
    schema.properties[arg.name] = {
      type: 'string',
      description: arg.description ?? '',
    }
    if (arg.required) {
      schema.required.push(arg.name)
    }
  }

  return schema
}

// ── 包装函数 ──────────────────────────────────────────────────────────────────

/**
 * 将 MCP Server 的一个工具定义包装为 myagent Tool。
 *
 * @param serverName  Server 名称，用于生成 `${serverName}__${toolName}` 命名
 * @param toolDef     MCP 工具定义
 * @param serverRef   MCPServer 实例引用
 * @returns Tool 实例
 */
export function wrapMCPTool(
  serverName: string,
  toolDef: MCPTool,
  serverRef: MCPServer,
): Tool {
  const toolName = `${serverName}__${toolDef.name}`

  return new class extends Tool {
    get name(): string { return toolName }
    get description(): string { return toolDef.description ?? `MCP tool from ${serverName}` }

    get input_schema(): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
      // MCP 的 inputSchema 已经是类 JSON Schema 格式，可直接透传
      const schema = toolDef.inputSchema ?? {}
      return {
        type: 'object',
        properties: (schema as any)?.properties ?? {},
        required: (schema as any)?.required ?? [],
      }
    }

    get parallelSafe(): boolean { return false }

    async checkPermission(_args: Record<string, unknown>): Promise<ToolPermissionResult> {
      // 交由 PermissionHook 统一决策
      return { action: 'defer' }
    }

    async execute(args: Record<string, unknown>): Promise<string> {
      return serverRef.callTool(toolDef.name, args)
    }
  }()
}

/**
 * 将 MCP Resource 包装为只读 Tool。
 *
 * 命名为 `${serverName}__resource__${resourceName}`，调用时执行 resources/read。
 */
export function wrapMCPResource(
  serverName: string,
  resource: MCPResource,
  serverRef: MCPServer,
): Tool {
  const resourceName = resource.name ?? resourceNameFromUri(resource.uri)
  const toolName = `${serverName}__resource__${resourceName}`
  const uri = resource.uri

  return new class extends Tool {
    get name(): string { return toolName }
    get description(): string {
      return resource.description
        ? `MCP resource: ${resource.description} (${uri})`
        : `Read MCP resource: ${uri}`
    }

    get input_schema(): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
      return {
        type: 'object',
        properties: {},
        required: [],
      }
    }

    get parallelSafe(): boolean { return true }

    async checkPermission(_args: Record<string, unknown>): Promise<ToolPermissionResult> {
      return { action: 'defer' }
    }

    async execute(_args: Record<string, unknown>): Promise<string> {
      return serverRef.readResource(uri)
    }
  }()
}

/**
 * 将 MCP Prompt 包装为 Tool。
 *
 * 命名为 `${serverName}__prompt__${promptName}`，调用时执行 prompts/get。
 * input_schema 根据 prompt.arguments 动态生成。
 */
export function wrapMCPPrompt(
  serverName: string,
  prompt: MCPPrompt,
  serverRef: MCPServer,
): Tool {
  const toolName = `${serverName}__prompt__${prompt.name}`

  return new class extends Tool {
    get name(): string { return toolName }
    get description(): string {
      return prompt.description
        ? `MCP prompt: ${prompt.description}`
        : `Get MCP prompt: ${prompt.name}`
    }

    get input_schema(): { type: 'object'; properties: Record<string, unknown>; required: string[] } {
      if (!prompt.arguments || prompt.arguments.length === 0) {
        return { type: 'object', properties: {}, required: [] }
      }
      const schema: { type: 'object'; properties: Record<string, unknown>; required: string[] } = {
        type: 'object',
        properties: {},
        required: [],
      }
      for (const arg of prompt.arguments) {
        schema.properties[arg.name] = {
          type: 'string',
          description: arg.description ?? `Argument "${arg.name}" for prompt "${prompt.name}"`,
        }
        if (arg.required) {
          schema.required.push(arg.name)
        }
      }
      return schema
    }

    get parallelSafe(): boolean { return false }

    async checkPermission(_args: Record<string, unknown>): Promise<ToolPermissionResult> {
      return { action: 'defer' }
    }

    async execute(args: Record<string, unknown>): Promise<string> {
      return serverRef.getPrompt(prompt.name, args)
    }
  }()
}

/**
 * 一键包装：给定一个 MCPServer，将所有 tools / resources / prompts 包装为 Tool 列表。
 * 遇到名称冲突时可调用 onConflict(serverName, localName) 来决定是否跳过。
 */
export function wrapAllFromServer(
  server: MCPServer,
  onConflict?: (serverName: string, toolName: string) => boolean,
): Tool[] {
  const tools: Tool[] = []
  const seen = new Set<string>()

  for (const toolDef of server.tools) {
    const toolName = `${server.name}__${toolDef.name}`
    if (seen.has(toolName)) continue
    seen.add(toolName)
    tools.push(wrapMCPTool(server.name, toolDef, server))
  }

  for (const resource of server.resources) {
    const resName = resource.name ?? resourceNameFromUri(resource.uri)
    const toolName = `${server.name}__resource__${resName}`
    if (seen.has(toolName)) continue
    seen.add(toolName)
    tools.push(wrapMCPResource(server.name, resource, server))
  }

  for (const prompt of server.prompts) {
    const toolName = `${server.name}__prompt__${prompt.name}`
    if (seen.has(toolName)) continue
    seen.add(toolName)
    tools.push(wrapMCPPrompt(server.name, prompt, server))
  }

  return tools
}
