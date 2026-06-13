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
  transport: 'stdio' | 'sse'
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
          transport: c.url ? 'sse' : 'stdio',
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
          transport: item.transport ?? (item.url ? 'sse' : 'stdio'),
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
   * 断开指定 Server。
   */
  async disconnect(name: string): Promise<void> {
    const server = this.servers.get(name)
    if (!server) return

    this.removeServerTools(name)
    await server.disconnect()
    this.notifyStatusChange()
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
   * 获取缓存的 IDE 选中状态（同步，供 drainAttachments 使用）。
   * 返回 null 表示无选中或选中已被清除。
   */
  getIDESelection(): {
    text: string
    filePath: string
    startLine: number
    endLine: number
  } | null {
    return this.ideSelectionCache
  }

  // ── 内部辅助 ────────────────────────────────────────────────────────────────

  private notifyStatusChange(): void {
    const infos = this.getServerInfos()
    for (const cb of this.statusListeners) {
      try { cb(infos) } catch { /* ignore callback errors */ }
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
