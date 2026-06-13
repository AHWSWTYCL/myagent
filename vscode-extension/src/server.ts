/**
 * server.ts — MCP Server 协议处理
 *
 * 处理 JSON-RPC 请求，支持:
 *   - initialize: 握手，返回 capabilities
 *   - tools/list: 返回 6 个工具定义
 *   - tools/call: 路由到工具实现
 *
 * 使用实例级 ID 计数器，避免与外部 MCP Server 的 ID 冲突
 */

import type { MCPTransport } from './transport.js'
import { executeToolAsync, getToolDefinitions } from './tools.js'

// ── 常量 ──────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2025-03-26'
const SERVER_INFO = { name: 'myagent', version: '0.1.0' }

// ── JSON-RPC 类型 ─────────────────────────────────────────────────────────────

interface JSONRPCRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

interface JSONRPCResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── MCP 标准错误码 ────────────────────────────────────────────────────────────

const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

// ── Server 实现 ───────────────────────────────────────────────────────────────

export function createMCPServer(transport: MCPTransport) {
  let initialized = false
  let _nextId = 1

  function nextId(): number {
    return _nextId++
  }

  async function handleRequest(raw: string): Promise<string> {
    let request: JSONRPCRequest

    try {
      request = JSON.parse(raw)
    } catch (err: any) {
      return jsonRPCError(null, ErrorCode.PARSE_ERROR, `Parse error: ${err.message}`)
    }

    if (!request.jsonrpc || request.jsonrpc !== '2.0' || !request.method) {
      return jsonRPCError(request.id ?? null, ErrorCode.INVALID_REQUEST, 'Invalid Request')
    }

    try {
      switch (request.method) {
        case 'initialize':
          return handleInitialize(request)
        case 'notifications/initialized':
          return '' // 通知不需要响应
        case 'tools/list':
          return handleToolsList(request)
        case 'tools/call':
          return await handleToolsCall(request)
        default:
          return jsonRPCError(request.id, ErrorCode.METHOD_NOT_FOUND, `Method not found: ${request.method}`)
      }
    } catch (err: any) {
      return jsonRPCError(request.id, ErrorCode.INTERNAL_ERROR, `Internal error: ${err.message}`)
    }
  }

  function handleInitialize(request: JSONRPCRequest): string {
    initialized = true
    return jsonRPCResult(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: SERVER_INFO,
    })
  }

  function handleToolsList(request: JSONRPCRequest): string {
    if (!initialized) {
      return jsonRPCError(request.id, ErrorCode.INVALID_REQUEST, 'Not initialized')
    }

    return jsonRPCResult(request.id, {
      tools: getToolDefinitions(),
    })
  }

  async function handleToolsCall(request: JSONRPCRequest): Promise<string> {
    if (!initialized) {
      return jsonRPCError(request.id, ErrorCode.INVALID_REQUEST, 'Not initialized')
    }

    const params = request.params ?? {}
    const name = params.name as string | undefined
    const args = (params.arguments ?? {}) as Record<string, unknown>

    if (!name) {
      return jsonRPCError(request.id, ErrorCode.INVALID_PARAMS, 'Missing tool name')
    }

    try {
      const result = await executeToolAsync(name, args)

      if (result.startsWith('Error:')) {
        return jsonRPCError(request.id, ErrorCode.INTERNAL_ERROR, result.slice(7))
      }

      return jsonRPCResult(request.id, {
        content: [{ type: 'text', text: result }],
      })
    } catch (err: any) {
      return jsonRPCError(request.id, ErrorCode.INTERNAL_ERROR, err.message)
    }
  }

  // ── 序列化辅助 ──────────────────────────────────────────────────────────

  function jsonRPCResult(id: number | string, result: unknown): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result })
  }

  function jsonRPCError(
    id: number | string | null,
    code: number,
    message: string,
    data?: unknown,
  ): string {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error: { code, message },
    }
    if (data !== undefined) response.error!.data = data
    return JSON.stringify(response)
  }

  return { handleRequest }
}
