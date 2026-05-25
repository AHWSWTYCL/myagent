/**
 * MCP (Model Context Protocol) JSON-RPC 2.0 协议层
 *
 * 提供消息类型定义、编解码函数和 MCP 特定方法常量。
 * 不依赖任何外部包，使用原生 JSON。
 */

// ── JSON-RPC 2.0 基础消息类型 ─────────────────────────────────────────────────

export interface JSONRPCRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JSONRPCResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JSONRPCNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification

// ── MCP 协议方法常量 ──────────────────────────────────────────────────────────

/** 客户端初始化握手 */
export const METHOD_INITIALIZE = 'initialize'
/** 客户端通知服务端初始化完成 */
export const METHOD_NOTIFICATION_INITIALIZED = 'notifications/initialized'
/** 获取工具列表 */
export const METHOD_TOOLS_LIST = 'tools/list'
/** 调用工具 */
export const METHOD_TOOLS_CALL = 'tools/call'
/** 获取资源列表 */
export const METHOD_RESOURCES_LIST = 'resources/list'
/** 读取资源 */
export const METHOD_RESOURCES_READ = 'resources/read'
/** 获取提示列表 */
export const METHOD_PROMPTS_LIST = 'prompts/list'
/** 获取提示内容 */
export const METHOD_PROMPTS_GET = 'prompts/get'
/** 服务端推送日志 */
export const METHOD_NOTIFICATION_LOG = 'notifications/message'
/** 服务端通知取消 */
export const METHOD_NOTIFICATION_CANCELLED = 'notifications/cancelled'

// ── MCP 特定类型 ──────────────────────────────────────────────────────────────

export interface MCPTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface MCPResource {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface MCPResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface MCPPromptArgument {
  name: string
  description?: string
  required?: boolean
}

export interface MCPPrompt {
  name: string
  description?: string
  arguments?: MCPPromptArgument[]
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant'
  content: { type: 'text'; text: string }
}

export interface MCPInitializeRequest {
  protocolVersion: string
  capabilities: {
    tools?: Record<string, unknown>
    resources?: Record<string, unknown>
    prompts?: Record<string, unknown>
  }
  clientInfo: { name: string; version: string }
}

export interface MCPInitializeResult {
  protocolVersion: string
  capabilities: {
    tools?: Record<string, unknown>
    resources?: Record<string, unknown>
    prompts?: Record<string, unknown>
    logging?: Record<string, unknown>
  }
  serverInfo: { name: string; version: string }
}

// ── 编解码函数 ────────────────────────────────────────────────────────────────

let _nextId = 1

/** 生成递增的 JSON-RPC 请求 ID */
export function nextId(): number {
  return _nextId++
}

/** 重置 ID 计数器（主要用于测试） */
export function resetIdCounter(): void {
  _nextId = 1
}

/**
 * 编码一个 JSON-RPC 请求。
 * 如果不传 id，自动生成递增 ID。
 */
export function encodeRequest(
  method: string,
  params?: Record<string, unknown>,
  id?: number | string,
): string {
  const msg: JSONRPCRequest = {
    jsonrpc: '2.0',
    id: id ?? nextId(),
    method,
  }
  if (params !== undefined) msg.params = params
  return JSON.stringify(msg)
}

/**
 * 编码一个 JSON-RPC 通知（无 id，不需要响应）。
 */
export function encodeNotification(
  method: string,
  params?: Record<string, unknown>,
): string {
  const msg: JSONRPCNotification = {
    jsonrpc: '2.0',
    method,
  }
  if (params !== undefined) msg.params = params
  return JSON.stringify(msg)
}

/**
 * 编码一个 JSON-RPC 响应。
 */
export function encodeResponse(
  id: number | string,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): string {
  const msg: JSONRPCResponse = {
    jsonrpc: '2.0',
    id,
  }
  if (error !== undefined) {
    msg.error = error
  } else {
    msg.result = result ?? null
  }
  return JSON.stringify(msg)
}

/**
 * 解析一行 JSON-RPC 消息。
 * 如果 JSON 解析失败返回 null（不抛异常）。
 */
export function parseMessage(data: string): JSONRPCMessage | null {
  try {
    const parsed = JSON.parse(data)
    if (parsed && typeof parsed === 'object' && parsed.jsonrpc === '2.0') {
      return parsed as JSONRPCMessage
    }
    return null
  } catch {
    return null
  }
}

/**
 * 判断消息类型
 */
export function isRequest(msg: JSONRPCMessage): msg is JSONRPCRequest {
  return 'id' in msg && !('result' in msg) && !('error' in msg)
}

export function isResponse(msg: JSONRPCMessage): msg is JSONRPCResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg)
}

export function isNotification(msg: JSONRPCMessage): msg is JSONRPCNotification {
  return !('id' in msg)
}

/**
 * 获取消息的 method 字段（请求和通知有 method，响应没有）。
 */
export function getMethod(msg: JSONRPCMessage): string | undefined {
  return (msg as JSONRPCRequest).method
}

// ── MCP 协议版本 ──────────────────────────────────────────────────────────────

/** 当前支持的 MCP 协议版本 */
export const SUPPORTED_PROTOCOL_VERSION = '2025-03-26'

/** 客户端信息 */
export const CLIENT_INFO = { name: 'myagent', version: '1.0.0' }
