/**
 * LSPClient — 底层 LSP JSON-RPC 通信层
 *
 * 使用 vscode-jsonrpc 的 createMessageConnection 管理双向 JSON-RPC。
 * 封装 spawn → listen → initialize 握手 → 请求/通知 → shutdown 完整生命周期。
 * 所有状态使用闭包管理，不引入 class。
 */

import { spawn, type ChildProcess } from 'child_process'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'

// ── LSP 类型（内联定义，避免依赖 vscode-languageserver-protocol）─────────────

export interface ServerCapabilities {
  definitionProvider?: boolean
  referencesProvider?: boolean
  hoverProvider?: boolean
  textDocumentSync?: unknown
  [key: string]: unknown
}

export interface InitializeParams {
  processId: number
  rootUri?: string
  rootPath?: string
  workspaceFolders?: Array<{ uri: string; name: string }>
  capabilities: Record<string, unknown>
  initializationOptions?: Record<string, unknown>
  [key: string]: unknown
}

export interface InitializeResult {
  capabilities: ServerCapabilities
  serverInfo?: { name: string; version: string }
}

// ── 类型导出 ──────────────────────────────────────────────────────────────────

export interface LSPClient {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean

  start(command: string, args: string[], options?: {
    env?: Record<string, string>
    cwd?: string
  }): Promise<void>

  initialize(params: InitializeParams): Promise<InitializeResult>

  sendRequest<TResult>(method: string, params: unknown): Promise<TResult>

  sendNotification(method: string, params: unknown): Promise<void>

  onNotification(method: string, handler: (params: unknown) => void): void

  stop(): Promise<void>
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────────

export function createLSPClient(serverName: string): LSPClient {
  let proc: ChildProcess | undefined
  let connection: MessageConnection | undefined
  let capabilities: ServerCapabilities | undefined
  let isInitialized = false
  let isStopping = false

  return {
    get capabilities() { return capabilities },
    get isInitialized() { return isInitialized },

    async start(command, args, options) {
      // 1. spawn 子进程
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...options?.env },
        cwd: options?.cwd,
      })

      if (!proc.stdout || !proc.stdin) {
        throw new Error('LSP server process stdio not available')
      }

      // 2. 等待 spawn 成功（ENOENT 等错误是异步触发的）
      await new Promise<void>((resolve, reject) => {
        proc!.once('spawn', () => resolve())
        proc!.once('error', (err: Error) => reject(err))
      })

      // 3. stderr → 日志（语言服务器的诊断输出）
      proc.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim()
        if (output) console.warn(`[lsp:${serverName}] ${output}`)
      })

      // 4. 进程退出处理
      proc.on('exit', (code) => {
        if (code !== 0 && code !== null && !isStopping) {
          console.warn(`[lsp:${serverName}] process exited with code ${code}`)
        }
        isInitialized = false
      })

      // 5. stdin 错误处理（防止 unhandled rejection）
      proc.stdin.on('error', (err: Error) => {
        if (!isStopping) console.warn(`[lsp:${serverName}] stdin error: ${err.message}`)
      })

      // 6. 创建 JSON-RPC 连接
      connection = createMessageConnection(
        new StreamMessageReader(proc.stdout),
        new StreamMessageWriter(proc.stdin),
      )

      // 7. 注册 error/close 处理器
      connection.onError(([error]) => {
        if (!isStopping) console.warn(`[lsp:${serverName}] connection error: ${error.message}`)
      })
      connection.onClose(() => {
        if (!isStopping) console.warn(`[lsp:${serverName}] connection closed`)
        isInitialized = false
      })

      // 8. 开始监听
      connection.listen()
    },

    async initialize(params) {
      if (!connection) throw new Error('LSP client not started')
      const result: InitializeResult = await connection.sendRequest('initialize', params)
      capabilities = result.capabilities
      await connection.sendNotification('initialized', {})
      isInitialized = true
      return result
    },

    async sendRequest(method, params) {
      if (!connection) throw new Error('LSP client not started')
      if (!isInitialized) throw new Error('LSP server not initialized')
      return connection.sendRequest(method, params)
    },

    async sendNotification(method, params) {
      if (!connection) throw new Error('LSP client not started')
      try {
        await connection.sendNotification(method, params)
      } catch {
        // 通知是 fire-and-forget，失败不抛
      }
    },

    onNotification(method, handler) {
      if (!connection) throw new Error('LSP client not started')
      connection.onNotification(method, handler)
    },

    async stop() {
      isStopping = true
      if (connection) {
        try {
          await connection.sendRequest('shutdown', {})
          await connection.sendNotification('exit', {})
        } catch {
          // shutdown 失败不影响清理
        } finally {
          connection.dispose()
          connection = undefined
        }
      }
      if (proc) {
        proc.removeAllListeners()
        try { proc.kill() } catch { /* 进程已退出 */ }
        proc = undefined
      }
      isInitialized = false
      capabilities = undefined
      isStopping = false
    },
  }
}
