/**
 * transport.ts — HTTP + SSE transport for VSCode MCP Server
 *
 * VSCode 插件内嵌 HTTP Server，提供:
 *   GET  /sse     → SSE event stream（myagent 通过 SSETransport 连接）
 *   POST /message → JSON-RPC 请求处理
 *
 * 端口策略: 固定端口 16888，写入 ~/.myagent/vscode-mcp.json 供 myagent 发现
 */

import * as http from 'http'
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
  let server: http.Server | null = null
  let _port = 0
  let sseClients: http.ServerResponse[] = []
  let callbacks: TransportCallbacks | null = null

  return {
    get port() { return _port },

    async start(cbs: TransportCallbacks) {
      callbacks = cbs

      server = http.createServer((req, res) => {
        // CORS for local development
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        // GET /sse → SSE stream
        if (req.url === '/sse' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',  // disable nginx buffering
          })

          // 立即发送 endpoint 事件，告诉 myagent POST 地址
          res.write(`event: endpoint\ndata: http://localhost:${_port}/message\n\n`)

          // 追踪连接，用于 clean shutdown
          sseClients.push(res)
          req.on('close', () => {
            sseClients = sseClients.filter(c => c !== res)
          })

          return
        }

        // POST /message → JSON-RPC
        if (req.url === '/message' && req.method === 'POST') {
          let body = ''
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf-8')
          })
          req.on('end', async () => {
            try {
              const result = await callbacks!.onRequest(body)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(result)
            } catch (err: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: `Parse error: ${err.message}` },
              }))
            }
          })
          return
        }

        // 404
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not Found')
      })

      // 动态端口
      await new Promise<void>((resolve, reject) => {
        server!.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port 16888 is in use. Is another VSCode instance running?`))
          } else {
            reject(err)
          }
        })
        server!.listen(16888, 'localhost', () => {
          _port = 16888
          writePortFile(_port)
          console.log(`[myagent] MCP Server listening on http://localhost:${_port}`)
          resolve()
        })
      })
    },

    async stop() {
      removePortFile()

      // 关闭所有 SSE 连接
      for (const client of sseClients) {
        try { client.end() } catch { /* ignore */ }
      }
      sseClients = []

      // 关闭 HTTP server — 需要追踪并强制关闭活跃 socket
      if (server) {
        const sockets = new Set<import('net').Socket>()
        server.on('connection', (socket) => sockets.add(socket))
        server.on('request', (_req, res) => {
          res.on('close', () => {
            if (res.socket) sockets.delete(res.socket)
          })
        })

        await new Promise<void>((resolve) => {
          server!.close(() => resolve())
          // 强制关闭活跃连接
          for (const socket of sockets) {
            socket.destroy()
          }
        })
        server = null
      }

      _port = 0
      callbacks = null
    },
  }
}
