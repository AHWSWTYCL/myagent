/**
 * transport.ts — WebSocket transport for VSCode MCP Server
 *
 * VSCode 插件内嵌 WebSocket Server，提供:
 *   ws://localhost:16888 → JSON-RPC 双向通信
 *
 * WebSocket 自带 ping/pong 保活（ws 库默认每 30s），无需应用层心跳。
 * 端口写入 ~/.myagent/vscode-mcp.json 供 myagent 发现。
 */

import { WebSocketServer, WebSocket } from 'ws'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface TransportCallbacks {
  onRequest(body: string): Promise<string>
  onClose(): void
}

export interface MCPTransport {
  readonly port: number
  start(callbacks: TransportCallbacks): Promise<void>
  stop(): Promise<void>
}

// ── 端口持久化 ────────────────────────────────────────────────────────────────

const MYAGENT_DIR = path.join(os.homedir(), '.myagent')
const PORT_FILE = path.join(MYAGENT_DIR, 'vscode-mcp.json')

function ensureMyagentDir(): void {
  if (!fs.existsSync(MYAGENT_DIR)) {
    fs.mkdirSync(MYAGENT_DIR, { recursive: true })
  }
}

function writePortFile(port: number): void {
  ensureMyagentDir()
  fs.writeFileSync(PORT_FILE, JSON.stringify({ port }))
}

function removePortFile(): void {
  try { fs.unlinkSync(PORT_FILE) } catch { /* ignore */ }
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────────

export function createTransport(): MCPTransport {
  let wss: WebSocketServer | null = null
  let _port = 0
  let _currentClient: WebSocket | null = null
  let callbacks: TransportCallbacks | null = null

  return {
    get port() { return _port },

    async start(cbs: TransportCallbacks) {
      callbacks = cbs

      wss = new WebSocketServer({ port: 16888, host: 'localhost' })

      wss.on('listening', () => {
        _port = 16888
        writePortFile(_port)
        console.log(`[myagent] WebSocket MCP Server listening on ws://localhost:${_port}`)
      })

      wss.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[myagent] Port 16888 is in use. Is another VSCode instance running?`)
        } else {
          console.error(`[myagent] WebSocket server error: ${err.message}`)
        }
      })

      wss.on('connection', (ws: WebSocket) => {
        // 只允许一个客户端连接；新连接踢掉旧连接
        if (_currentClient) {
          console.log('[myagent] New client connected, closing old connection')
          try { _currentClient.close(1000, 'new client connected') } catch { /* ignore */ }
        }
        _currentClient = ws
        console.log('[myagent] MCP client connected')

        ws.on('message', async (data: Buffer) => {
          try {
            const response = await callbacks!.onRequest(data.toString())
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(response)
            }
          } catch (err: any) {
            console.error(`[myagent] Request handling error: ${err.message}`)
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: `Parse error: ${err.message}` },
              }))
            }
          }
        })

        ws.on('close', (code, reason) => {
          console.log(`[myagent] MCP client disconnected (code=${code}, reason=${reason?.toString() || 'none'})`)
          if (_currentClient === ws) {
            _currentClient = null
          }
          callbacks?.onClose()
        })

        ws.on('error', (err) => {
          console.error(`[myagent] WebSocket client error: ${err.message}`)
        })
      })

      // 等待 server 启动
      await new Promise<void>((resolve, reject) => {
        if (wss!.address()) {
          resolve()
          return
        }
        wss!.once('listening', () => resolve())
        wss!.once('error', (err) => reject(err))
      })
    },

    async stop() {
      // 关闭当前客户端连接
      if (_currentClient) {
        try { _currentClient.close(1000, 'server shutting down') } catch { /* ignore */ }
        _currentClient = null
      }

      // 关闭 WebSocket server
      const server = wss
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          // 强制关闭所有连接
          for (const client of server.clients) {
            client.terminate()
          }
        })
        wss = null
      }

      removePortFile()
      _port = 0
      callbacks = null
    },
  }
}
