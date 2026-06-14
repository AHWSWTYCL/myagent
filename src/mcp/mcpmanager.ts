/**
 * MCP Manager — 管理多个 MCP Server 的生命周期和工具注册。
 *
 * 职责：
 * 1. 从配置文件加载 MCP Server 列表
 * 2. 启动/停止/重连各个 Server
 * 3. 将 Server 暴露的 tools/resources/prompts 包装为 Tool 并注册
 * 4. 故障隔离：单个 Server 异常不影响其他
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

import { MCPServer, type MCPServerConfig, type ServerStatus } from './mcpserver.js'
import { wrapAllFromServer } from './mcptoolwrapper.js'
import type { Tool } from '../tools/tool.js'
import type { ToolRegistrar } from '../tools/toolregistrar.js'

// ── 公开类型 ──────────────────────────────────────────────────────────────────

export interface MCPServerInfo {
  name: string
  status: ServerStatus
  serverInfo?: { name: string; version: string }
  toolCount: number
  resourceCount: number
  promptCount: number
  transport: 'stdio' | 'sse' | 'ws'
  error?: string
}

export type StatusChangeCallback = (infos: MCPServerInfo[]) => void

// ── 配置路径 ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.myagent', 'mcp-servers.json')
const ENV_CONFIG_PATH = process.env.MYAGENT_MCP_CONFIG
const VSCode_PORT_FILE = path.join(os.homedir(), '.myagent', 'vscode-mcp.json')

function getConfigPath(): string {
  return ENV_CONFIG_PATH || DEFAULT_CONFIG_PATH
}

// ── MCPManager ────────────────────────────────────────────────────────────────

export class MCPManager {
  private servers = new Map<string, MCPServer>()
  private mcpTools: Tool[] = []       // 当前所有 MCP 来源的 Tool
  private statusListeners: StatusChangeCallback[] = []

  /** 自动重连定时器（按 server 名） */
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 自动重连退避延迟（毫秒），成功连接后重置 */
  private reconnectDelays = new Map<string, number>()
  /** 主动断开的 server 集合（不自动重连） */
  private intentionalDisconnects = new Set<string>()
  private readonly INITIAL_RECONNECT_DELAY = 1_000
  private readonly MAX_RECONNECT_DELAY = 30_000

  /** ToolRegistrar 引用（后置注入，解决循环依赖） */
  private registrar: ToolRegistrar | null = null
  /** 已注册的工具名集合（用于冲突检测） */
  private registeredNames = new Set<string>()

  /** VSCode 诊断缓存：每次 turn 前异步拉取，drainAttachments 同步读取 */
  private vscodeDiagsCache: string | null = null

  /** IDE 选中缓存：每次 turn 前异步拉取 getSelection，drainAttachments 同步读取 */
  private ideSelectionCache: {
    text: string
    filePath: string
    startLine: number
    endLine: number
  } | null = null

  /**
   * 设置 ToolRegistrar 引用。
   * 必须在 startAll 之前调用。
   */
  setRegistrar(registrar: ToolRegistrar): void {
    this.registrar = registrar
    // 收集已有工具名
    for (const t of registrar.getAllTools()) {
      this.registeredNames.add(t.name)
    }
  }

  /**
   * 加载配置文件。
   * 文件不存在或格式错误时返回空数组，不抛异常。
   */
  loadConfigFromFile(): MCPServerConfig[] {
    const configPath = getConfigPath()
    if (!fs.existsSync(configPath)) {
      return []
    }

    let raw: string
    try {
      raw = fs.readFileSync(configPath, 'utf-8')
    } catch (err: any) {
      console.warn(`[mcp] WARN: failed to read config at ${configPath}: ${err.message}`)
      return []
    }

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn(`[mcp] WARN: failed to parse config at ${configPath}`)
      return []
    }

    // 支持两种格式：
    // 1. { mcpServers: { name: { command, args, url, ... } } }  （Claude Code 兼容）
    // 2. { servers: [{ name, transport, command, args, url, ... }] } （myagent 原生）
    const servers: MCPServerConfig[] = []

    // 格式1：mcpServers 对象
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
        const c = cfg as Record<string, any>
        const server: MCPServerConfig = {
          name: name.toLowerCase().replace(/[\s_]+/g, '-'),
          transport: c.url ? (c.url.startsWith('ws://') || c.url.startsWith('wss://') ? 'ws' : 'sse') : 'stdio',
          command: c.command,
          args: c.args,
          env: c.env,
          url: c.url,
          headers: c.headers,
        }
        if (server.transport === 'stdio' && !server.command) {
          console.warn(`[mcp] WARN: server "${name}" has no command, skipping`)
          continue
        }
        if (server.transport === 'sse' && !server.url) {
          console.warn(`[mcp] WARN: server "${name}" has no url, skipping`)
          continue
        }
        // 检测 VSCode 插件是否激活（通过端口文件）
        if (server.name === 'vscode' && !fs.existsSync(VSCode_PORT_FILE)) {
          console.log('[mcp] VSCode plugin not active, skipping vscode server')
          continue
        }
        servers.push(server)
      }
    }

    // 格式2: servers 数组
    if (parsed.servers && Array.isArray(parsed.servers)) {
      for (const item of parsed.servers) {
        const server: MCPServerConfig = {
          name: (item.name ?? '').toLowerCase().replace(/[\s_]+/g, '-'),
          transport: item.transport ?? (item.url ? (item.url.startsWith('ws://') || item.url.startsWith('wss://') ? 'ws' : 'sse') : 'stdio'),
          command: item.command,
          args: item.args,
          env: item.env,
          url: item.url,
          headers: item.headers,
        }
        if (!server.name) {
          console.warn(`[mcp] WARN: server entry missing name, skipping`)
          continue
        }
        if (server.transport === 'stdio' && !server.command) {
          console.warn(`[mcp] WARN: server "${server.name}" has no command, skipping`)
          continue
        }
        if (server.transport === 'sse' && !server.url) {
          console.warn(`[mcp] WARN: server "${server.name}" has no url, skipping`)
          continue
        }
        // 避免重复（如果 format1 已添加了同名 server）
        if (!servers.find(s => s.name === server.name)) {
          servers.push(server)
        }
      }
    }

    return servers
  }

  /**
   * 加载配置并启动所有 Server。
   * 返回成功连接的 Server 数量。
   */
  async startAll(configs?: MCPServerConfig[]): Promise<number> {
    const cfgs = configs ?? this.loadConfigFromFile()
    if (cfgs.length === 0) {
      console.log('[mcp] No MCP servers configured')
      return 0
    }

    console.log(`[mcp] Starting ${cfgs.length} MCP server(s)...`)

    await Promise.allSettled(
      cfgs.map(cfg => this.startServer(cfg)),
    )

    const successCount = Array.from(this.servers.values())
      .filter(s => s.status === 'connected').length

    const errorCount = Array.from(this.servers.values())
      .filter(s => s.status === 'error').length

    console.log(`[mcp] ${successCount}/${cfgs.length} connected, ${errorCount} failed`)
    return successCount
  }

  /**
   * 启动单个 Server 并注册其工具。
   */
  async startServer(config: MCPServerConfig): Promise<void> {
    const existing = this.servers.get(config.name)
    if (existing && existing.status === 'connected') {
      console.log(`[mcp] Server "${config.name}" already connected`)
      return
    }

    const server = new MCPServer(config)
    this.servers.set(config.name, server)
    // 新连接 → 清除主动断开标记和重连状态
    this.intentionalDisconnects.delete(config.name)
    this.cancelReconnect(config.name)
    this.reconnectDelays.delete(config.name)

    // 状态变化监听
    server.onStatusChange(() => this.notifyStatusChange())
    server.onError((err) => {
      console.warn(`[mcp] ERROR: server "${config.name}": ${err.message}`)
      this.notifyStatusChange()
    })

    // 启动连接
    await server.connect()

    if (server.status === 'connected') {
      // 包装并注册工具
      const tools = wrapAllFromServer(server)
      this.registerTools(server.name, tools)
    }

    this.notifyStatusChange()
  }

  /**
   * 注册 MCP 工具到 ToolRegistrar，处理命名冲突。
   */
  private registerTools(serverName: string, tools: Tool[]): void {
    for (const tool of tools) {
      if (this.registeredNames.has(tool.name)) {
        console.warn(
          `[mcp] WARN: tool "${tool.name}" from server "${serverName}" conflicts with existing tool, skipped`,
        )
        continue
      }

      this.mcpTools.push(tool)
      this.registeredNames.add(tool.name)

      if (this.registrar) {
        this.registrar.registerTool(tool)
      }
    }
  }

  /**
   * 优雅关闭所有 Server。
   */
  async shutdownAll(): Promise<void> {
    // 取消所有重连定时器
    for (const [name, timer] of this.reconnectTimers) {
      clearTimeout(timer)
    }
    this.reconnectTimers.clear()
    this.reconnectDelays.clear()
    this.intentionalDisconnects.clear()

    const tasks: Promise<void>[] = []
    for (const [name, server] of this.servers) {
      tasks.push(
        server.disconnect().catch((err) => {
          console.warn(`[mcp] Error disconnecting "${name}": ${err.message}`)
        }),
      )
    }
    await Promise.allSettled(tasks)
    this.servers.clear()
    this.mcpTools = []
    this.notifyStatusChange()
  }

  /**
   * 重新连接指定 Server。
   */
  async reconnect(name: string): Promise<void> {
    const server = this.servers.get(name)
    if (!server) {
      console.warn(`[mcp] Server "${name}" not found`)
      return
    }

    // 先移除旧工具
    this.removeServerTools(name)

    await server.reconnect()

    if (server.status === 'connected') {
      const tools = wrapAllFromServer(server)
      this.registerTools(name, tools)
    }

    this.notifyStatusChange()
  }

  /**
   * 断开指定 Server（主动断开，不自动重连）。
   */
  async disconnect(name: string): Promise<void> {
    const server = this.servers.get(name)
    if (!server) return

    this.intentionalDisconnects.add(name)
    this.cancelReconnect(name)
    this.removeServerTools(name)
    await server.disconnect()
    this.notifyStatusChange()
  }

  /**
   * 调度自动重连（指数退避）。
   * 已有的重连定时器会被取消，用新的延迟重新调度。
   */
  private scheduleReconnect(name: string): void {
    // 已有定时器则跳过（不重复调度）
    if (this.reconnectTimers.has(name)) return

    const currentDelay = this.reconnectDelays.get(name) ?? this.INITIAL_RECONNECT_DELAY
    const nextDelay = Math.min(currentDelay * 2, this.MAX_RECONNECT_DELAY)
    this.reconnectDelays.set(name, nextDelay)

    console.log(`[mcp] Server "${name}" disconnected, retrying in ${Math.round(currentDelay / 1000)}s...`)

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(name)
      try {
        const server = this.servers.get(name)
        if (!server) return

        // 移除旧工具（重连成功后会重新注册）
        this.removeServerTools(name)
        await server.reconnect()

        if (server.status === 'connected') {
          // 重连成功 → 重置退避延迟
          this.reconnectDelays.delete(name)
          const tools = wrapAllFromServer(server)
          this.registerTools(name, tools)
          console.log(`[mcp] Server "${name}" reconnected`)
        }
      } catch (err: any) {
        console.warn(`[mcp] Server "${name}" reconnect failed: ${err.message}`)
      }
      // notifyStatusChange 会由 server 的状态回调触发，不在此调用
    }, currentDelay)

    this.reconnectTimers.set(name, timer)
  }

  /**
   * 取消指定 server 的自动重连定时器。
   */
  private cancelReconnect(name: string): void {
    const timer = this.reconnectTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(name)
    }
    this.reconnectDelays.delete(name)
  }

  /**
   * 获取所有 MCP 工具（只读快照）。
   */
  getTools(): Tool[] {
    return [...this.mcpTools]
  }

  /**
   * 获取所有 Server 状态信息。
   */
  getServerInfos(): MCPServerInfo[] {
    const infos: MCPServerInfo[] = []
    for (const server of this.servers.values()) {
      infos.push({
        name: server.name,
        status: server.status,
        serverInfo: server.serverInfo ?? undefined,
        toolCount: server.tools.length,
        resourceCount: server.resources.length,
        promptCount: server.prompts.length,
        transport: server.config.transport,
      })
    }
    return infos
  }

  /**
   * 监听状态变化。
   */
  onStatusChange(callback: StatusChangeCallback): void {
    this.statusListeners.push(callback)
  }

  /**
   * 拉取 VSCode 插件的最新诊断信息和选中状态，写入缓存。
   * 每次 turn 开始前调用（fire-and-forget）。
   */
  async fetchVSCodeDiagnostics(): Promise<void> {
    const server = this.servers.get('vscode')
    if (!server || server.status !== 'connected') {
      this.vscodeDiagsCache = null
      this.ideSelectionCache = null
      return
    }

    // 诊断拉取
    try {
      const raw = await server.callTool('getDiagnostics', {})
      if (raw.startsWith('Error:')) {
        this.vscodeDiagsCache = null
      } else {
        const parsed = JSON.parse(raw)
        if (parsed.summary?.errors + parsed.summary?.warnings + parsed.summary?.hints === 0) {
          this.vscodeDiagsCache = null
        } else {
          this.vscodeDiagsCache = raw
        }
      }
    } catch {
      this.vscodeDiagsCache = null
    }

    // 选中内容拉取（与诊断并行，但此处顺序调用避免额外复杂度）
    try {
      const raw = await server.callTool('getSelection', {})
      if (raw.startsWith('Error:') || raw === 'No active editor') {
        this.ideSelectionCache = null
        return
      }
      const parsed = JSON.parse(raw)
      if (!parsed.text || parsed.text.length === 0) {
        this.ideSelectionCache = null // 空选中 = 用户取消了选择
        return
      }
      this.ideSelectionCache = {
        text: parsed.text,
        filePath: parsed.filePath,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
      }
    } catch {
      this.ideSelectionCache = null
    }
  }

  /**
   * 获取缓存的 VSCode 诊断信息（同步，供 drainAttachments 使用）。
   */
  getVSCodeDiagnostics(): string | null {
    return this.vscodeDiagsCache
  }

  /**
   * 获取并消费缓存的 VSCode 诊断信息（同步，供 drainAttachments 使用）。
   * 去重规则：基于 errors/warnings/hints 计数 + 文件名列表生成签名，
   * 相同签名跳过。诊断变化时返回新的 JSON 并更新签名。
   */
  getVSCodeDiagnosticsAndClear(): string | null {
    const raw = this.vscodeDiagsCache
    if (!raw) return null

    // 生成稳定签名（忽略时间戳等变化字段）
    let sig: string
    try {
      const parsed = JSON.parse(raw)
      const s = parsed.summary ?? {}
      const files = (parsed.files as Array<{ file: string }> | undefined) ?? []
      sig = `${s.errors ?? 0}:${s.warnings ?? 0}:${s.hints ?? 0}:${files.map(f => f.file).sort().join(',')}`
    } catch {
      sig = raw
    }

    if (sig === this.lastInjectedDiagnosticsSig) {
      this.vscodeDiagsCache = null // 消费（即使跳过也清除缓存，避免内存泄漏）
      return null
    }

    this.lastInjectedDiagnosticsSig = sig
    this.vscodeDiagsCache = null // 消费后清除
    return raw
  }

  /**
   * 上次已注入 LLM 上下文的诊断签名（用于去重）。
   * 基于诊断摘要（errors/warnings/hints 计数 + 文件名列表），
   * 同一诊断快照不重复注入。
   */
  private lastInjectedDiagnosticsSig: string | null = null

  /**
   * 上次已注入 LLM 上下文的选中摘要（用于去重）。
   * key = `${filePath}:${startLine}:${endLine}:${text}`
   * Claude Code 风格：push 模型下 selection 只在变化时通知；
   * poll 模型下使用内容签名去重，防止同一选中重复注入。
   */
  private lastInjectedSelectionSig: string | null = null

  /**
   * 获取并消费缓存的 IDE 选中状态（同步，供 drainAttachments 使用）。
   * 去重规则：如果当前选中与上次注入 LLM 的选中完全一致（内容 + 位置），
   * 返回 null。否则记录签名并返回选中数据。
   */
  getIDESelectionAndClear(): {
    text: string
    filePath: string
    startLine: number
    endLine: number
  } | null {
    const sel = this.ideSelectionCache
    if (!sel) return null

    const sig = `${sel.filePath}:${sel.startLine}:${sel.endLine}:${sel.text}`
    if (sig === this.lastInjectedSelectionSig) {
      return null // 与上次相同，跳过
    }

    this.lastInjectedSelectionSig = sig
    this.ideSelectionCache = null // 消费后清除
    return sel
  }

  /**
   * 获取缓存的 IDE 选中状态（同步，供 drainAttachments 使用）。
   * ⚠️ 不带去重，消费后不自动清除。仅用于需要主动轮询的场景。
   * 推荐使用 getIDESelectionAndClear() 代替本方法。
   */
  getIDESelection(): {
    text: string
    filePath: string
    startLine: number
    endLine: number
  } | null {
    return this.ideSelectionCache
  }

  /**
   * 调用指定 MCP Server 的工具（fire-and-forget 友好，不抛异常）。
   * 返回工具调用的结果字符串，失败返回错误字符串。
   * @param timeout 可选超时（毫秒），用于长时间等待的工具（如交互式 diff）
   */
  async callServerTool(serverName: string, toolName: string, args: Record<string, unknown>, timeout?: number): Promise<string> {
    const server = this.servers.get(serverName)
    if (!server || server.status !== 'connected') {
      return `Error: MCP server "${serverName}" not connected`
    }
    return server.callTool(toolName, args, timeout)
  }

  // ── 内部辅助 ────────────────────────────────────────────────────────────────

  private notifyStatusChange(): void {
    const infos = this.getServerInfos()
    for (const cb of this.statusListeners) {
      try { cb(infos) } catch { /* ignore callback errors */ }
    }

    // 自动重连：检测断开的 server（非主动断开）
    for (const [name, server] of this.servers) {
      if (server.status === 'disconnected' && !this.intentionalDisconnects.has(name)) {
        this.scheduleReconnect(name)
      }
    }
  }

  /** 移除指定 Server 注册的所有工具 */
  private removeServerTools(serverName: string): void {
    const prefix = `${serverName}__`
    const toRemove: string[] = []

    for (const tool of this.mcpTools) {
      if (tool.name.startsWith(prefix)) {
        toRemove.push(tool.name)
      }
    }

    this.mcpTools = this.mcpTools.filter(t => !toRemove.includes(t.name))
    for (const name of toRemove) {
      this.registeredNames.delete(name)
      // Drop from the main registry so subsequent runAgentLoopStream calls
      // don't expose a tool that has no live MCP connection backing it.
      this.registrar?.removeTool(name)
    }
  }
}
