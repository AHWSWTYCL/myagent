/**
 * 单个 MCP Server 连接的生命周期管理。
 *
 * 封装了从握手 → 工具发现 → 工具调用 → 断开的完整流程。
 * 通过 Transport 层收发 JSON-RPC 消息，使用请求 ID 匹配响应。
 */

import { MCPTransport, StdioTransport, SSETransport } from './mcptransport.js'
import {
  MCPTool, MCPResource, MCPPrompt,
  MCPInitializeResult,
  encodeRequest, encodeNotification,
  parseMessage, isRequest, isResponse,
  nextId, getMethod,
  METHOD_INITIALIZE, METHOD_NOTIFICATION_INITIALIZED,
  METHOD_TOOLS_LIST, METHOD_TOOLS_CALL,
  METHOD_RESOURCES_LIST, METHOD_RESOURCES_READ,
  METHOD_PROMPTS_LIST, METHOD_PROMPTS_GET,
  SUPPORTED_PROTOCOL_VERSION, CLIENT_INFO,
} from './mcpprotocol.js'

// ── 配置与状态 ─────────────────────────────────────────────────────────────────

export interface MCPServerConfig {
  /** Server 唯一标识名，用于生成工具名前缀 */
  name: string
  /** 传输方式 */
  transport: 'stdio' | 'sse'
  /** stdio 模式：启动命令 */
  command?: string
  /** stdio 模式：命令参数 */
  args?: string[]
  /** stdio 模式：环境变量 */
  env?: Record<string, string>
  /** SSE 模式：端点 URL */
  url?: string
  /** SSE 模式：自定义请求头 */
  headers?: Record<string, string>
}

export type ServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// ── 挂起的请求 ────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

// ── MCPServer ─────────────────────────────────────────────────────────────────

export class MCPServer {
  readonly name: string
  readonly config: MCPServerConfig

  private transport: MCPTransport | null = null
  private _status: ServerStatus = 'disconnected'
  private pending = new Map<number | string, PendingRequest>()
  private _tools: MCPTool[] = []
  private _resources: MCPResource[] = []
  private _prompts: MCPPrompt[] = []
  private _serverInfo: { name: string; version: string } | null = null
  private statusCallbacks: Array<(status: ServerStatus) => void> = []
  private errorCallbacks: Array<(err: Error) => void> = []

  /** 单个工具调用的默认超时（毫秒） */
  readonly toolCallTimeout: number

  constructor(config: MCPServerConfig, toolCallTimeout = 30_000) {
    this.name = config.name
    this.config = config
    this.toolCallTimeout = toolCallTimeout
  }

  // ── 状态访问器 ──────────────────────────────────────────────────────────────

  get status(): ServerStatus { return this._status }
  get tools(): MCPTool[] { return this._tools }
  get resources(): MCPResource[] { return this._prompts.length > 0 ? this._resources : [] }
  get prompts(): MCPPrompt[] { return this._prompts }
  get serverInfo(): { name: string; version: string } | null { return this._serverInfo }

  private setStatus(s: ServerStatus): void {
    if (this._status === s) return
    this._status = s
    for (const cb of this.statusCallbacks) cb(s)
  }

  onStatusChange(callback: (status: ServerStatus) => void): void {
    this.statusCallbacks.push(callback)
  }

  onError(callback: (err: Error) => void): void {
    this.errorCallbacks.push(callback)
  }

  // ── 连接生命周期 ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._status === 'connected') return
    if (this._status === 'connecting') return

    this.setStatus('connecting')

    try {
      // 1. 创建传输层
      this.transport = this.createTransport()

      // 2. 注册消息处理器
      this.transport.onMessage((data) => this.handleMessage(data))
      this.transport.onError((err) => {
        this.setStatus('error')
        for (const cb of this.errorCallbacks) cb(err)
      })
      this.transport.onClose(() => {
        this.cleanupPending(new Error('Transport closed'))
        this.setStatus('disconnected')
      })

      // 3. 建立连接
      await this.transport.connect()

      // 4. 握手：发送 initialize
      const initResult = await this.request<MCPInitializeResult>(METHOD_INITIALIZE, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        clientInfo: CLIENT_INFO,
      })
      this._serverInfo = initResult.serverInfo ?? { name: this.name, version: 'unknown' }

      // 5. 通知初始化完成
      await this.sendNotification(METHOD_NOTIFICATION_INITIALIZED)

      // 6. 获取工具列表
      if (initResult.capabilities?.tools !== undefined) {
        const toolResult = await this.request<{ tools: MCPTool[] }>(METHOD_TOOLS_LIST)
        this._tools = toolResult.tools ?? []
      }

      // 7. 获取资源列表
      if (initResult.capabilities?.resources !== undefined) {
        const resourceResult = await this.request<{ resources: MCPResource[] }>(METHOD_RESOURCES_LIST)
        this._resources = resourceResult.resources ?? []
      }

      // 8. 获取提示列表
      if (initResult.capabilities?.prompts !== undefined) {
        const promptResult = await this.request<{ prompts: MCPPrompt[] }>(METHOD_PROMPTS_LIST)
        this._prompts = promptResult.prompts ?? []
      }

      this.setStatus('connected')
    } catch (err: any) {
      this.setStatus('error')
      // 不抛异常到上层 —— 符合 AC7（优雅跳过）
      console.warn(`[mcp] server "${this.name}" connect error: ${err.message}`)
    }
  }

  async disconnect(): Promise<void> {
    this.cleanupPending(new Error('Server disconnected'))
    this._tools = []
    this._resources = []
    this._prompts = []
    this._serverInfo = null
    this.setStatus('disconnected')
    await this.transport?.disconnect()
    this.transport = null
  }

  async reconnect(): Promise<void> {
    await this.disconnect()
    await this.connect()
  }

  // ── 工具调用 ────────────────────────────────────────────────────────────────

  /**
   * 调用 MCP 工具。
   * 返回结果字符串（与 myagent Tool.execute() 规范一致），失败也返回错误字符串。
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (this._status !== 'connected') {
      return `Error: MCP server "${this.name}" is disconnected`
    }

    try {
      const result = await this.request<{ content: Array<{ type: string; text?: string }> }>(
        METHOD_TOOLS_CALL,
        { name: toolName, arguments: args },
        this.toolCallTimeout,
      )

      if (!result.content || !Array.isArray(result.content)) {
        return `Error: MCP tool "${toolName}" returned invalid response`
      }

      // 拼接所有 text 类型的 content
      return result.content
        .filter((c) => c.type === 'text' && c.text != null)
        .map((c) => c.text!)
        .join('\n')
    } catch (err: any) {
      return `Error: MCP call to "${this.name}/${toolName}" failed: ${err.message}`
    }
  }

  /**
   * 读取 MCP 资源。
   */
  async readResource(uri: string): Promise<string> {
    if (this._status !== 'connected') {
      return `Error: MCP server "${this.name}" is disconnected`
    }

    try {
      const result = await this.request<{ contents: Array<{ text?: string; blob?: string }> }>(
        METHOD_RESOURCES_READ,
        { uri },
        this.toolCallTimeout,
      )

      if (!result.contents || !Array.isArray(result.contents)) {
        return `Error: MCP resource "${uri}" returned invalid response`
      }

      return result.contents
        .map((c) => c.text ?? (c.blob ? `<binary blob ${c.blob.length} bytes>` : ''))
        .join('\n')
    } catch (err: any) {
      return `Error: MCP resource read "${uri}" failed: ${err.message}`
    }
  }

  /**
   * 获取 MCP Prompt。
   */
  async getPrompt(promptName: string, args?: Record<string, unknown>): Promise<string> {
    if (this._status !== 'connected') {
      return `Error: MCP server "${this.name}" is disconnected`
    }

    try {
      const params: Record<string, unknown> = { name: promptName }
      if (args !== undefined) params.arguments = args

      const result = await this.request<{ messages: Array<{ role: string; content: { type: string; text: string } }> }>(
        METHOD_PROMPTS_GET,
        params,
        this.toolCallTimeout,
      )

      if (!result.messages || !Array.isArray(result.messages)) {
        return `Error: MCP prompt "${promptName}" returned invalid response`
      }

      return result.messages
        .map((m) => `[${m.role}]\n${m.content.text}`)
        .join('\n\n')
    } catch (err: any) {
      return `Error: MCP prompt get "${promptName}" failed: ${err.message}`
    }
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────────

  /** 根据配置创建对应的 Transport */
  private createTransport(): MCPTransport {
    if (this.config.transport === 'sse') {
      if (!this.config.url) throw new Error('SSE transport requires a url')
      return new SSETransport({
        url: this.config.url,
        headers: this.config.headers,
      })
    }

    // stdio
    if (!this.config.command) throw new Error('stdio transport requires a command')
    return new StdioTransport({
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
    })
  }

  /** 发送一个请求并等待响应 */
  private request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeout = 30_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request "${method}" timed out after ${timeout}ms`))
      }, timeout)

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })

      const msg = encodeRequest(method, params, id)
      this.transport?.send(msg).catch((err) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /** 发送一个通知（无需响应） */
  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const msg = encodeNotification(method, params)
    await this.transport?.send(msg)
  }

  /** 处理收到的消息 */
  private handleMessage(data: string): void {
    const msg = parseMessage(data)
    if (!msg) return

    // 响应 → 匹配 pending 请求
    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id)
      if (!pending) return // 未知的响应 ID，忽略

      this.pending.delete(msg.id)
      clearTimeout(pending.timer)

      if (msg.error) {
        pending.reject(new Error(`MCP error: ${msg.error.message}`))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    // 请求（来自 Server 的请求，如通知）→ 记录日志
    if (isRequest(msg)) {
      const method = getMethod(msg)
      if (method && method.startsWith('notifications/')) {
        // 服务端通知，仅日志
        if (method === METHOD_NOTIFICATION_LOG) {
          const params = msg.params as { level?: string; data?: unknown } | undefined
          console.warn(`[mcp:${this.name}] ${params?.level ?? 'info'}:`, params?.data ?? '')
        }
      }
      return
    }
  }

  /** 清理所有 pending 请求 */
  private cleanupPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }
}
