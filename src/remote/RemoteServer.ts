/**
 * RemoteServer — HTTP + SSE server that lets external apps control myagent.
 *
 * 架构：
 *   POST /api/message  →  MessageQueue.enqueue()（和 TUI InputBox 走同一条路径）
 *   GET  /api/events    →  SSE stream（TuiBridge 事件 → JSON）
 *                         - 每个事件带 id:N 前缀，支持断线重连
 *                         - 客户端发 Last-Event-Id 头可从中断点续传
 *   GET  /api/health    →  健康检查（含 agent 运行状态）
 *
 * 设计意图：
 *   - 零外部依赖，仅使用 Node.js 内置 http 模块
 *   - TuiBridge 的所有关键事件泛化转发，不做语义转换
 *   - Demo 级：无认证、CORS 全开
 */

import http from 'http'
import type { TuiBridge } from '../tui/bridge.js'
import type { MessageQueue } from '../messagequeue.js'
import { sessionState } from '../state/sessionState.js'

export interface RemoteServerOptions {
  port: number
  bridge: TuiBridge
  messageQueue: MessageQueue
}

interface SSEClient {
  id: number
  res: http.ServerResponse
  /** 客户端请求的断线重连起点（Last-Event-Id），重放完后清零 */
  replayFrom: number
}

/** 环形缓冲中的一条事件记录 */
interface EventRecord {
  id: number
  payload: string
}

export class RemoteServer {
  private server: http.Server | null = null
  private port: number
  private bridge: TuiBridge
  private messageQueue: MessageQueue
  private sseClients: SSEClient[] = []
  private nextClientId = 1
  private bridgeHandlers = new Map<string, (data: unknown) => void>()
  private eventCounter = 0
  private eventRing: EventRecord[] = []
  private static MAX_EVENT_RING = 200

  constructor(options: RemoteServerOptions) {
    this.port = options.port
    this.bridge = options.bridge
    this.messageQueue = options.messageQueue
  }

  /** 启动 HTTP server，返回实际监听端口 */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res))

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[remote] Port ${this.port} is already in use. Try a different port with --remote-port.`)
        }
        reject(err)
      })

      this.server.listen(this.port, () => {
        const addr = this.server!.address()
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port
        console.log(`[remote] Server listening on http://localhost:${actualPort}`)
        this.setupBridgeForwarding()
        resolve(actualPort)
      })
    })
  }

  /** 关闭 server 并断开所有 SSE 连接 */
  async stop(): Promise<void> {
    // 清理 Bridge 事件监听器，防止多次 start/stop 叠加
    for (const [event, handler] of this.bridgeHandlers) {
      this.bridge.removeListener(event, handler)
    }
    this.bridgeHandlers.clear()

    // 断开所有 SSE 客户端
    for (const client of this.sseClients) {
      client.res.end()
    }
    this.sseClients = []

    if (this.server) {
      return new Promise(resolve => {
        // 超时保护：防止僵尸连接导致 stop() 永久挂起
        const forceTimeout = setTimeout(() => resolve(), 1000)
        this.server!.close(() => {
          clearTimeout(forceTimeout)
          resolve()
        })
      })
    }
  }

  // ── 路由分发 ──────────────────────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS: demo 级全开
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`)

    if (req.method === 'POST' && url.pathname === '/api/message') {
      this.handlePostMessage(req, res)
    } else if (req.method === 'GET' && url.pathname === '/api/events') {
      this.handleSSE(req, res)
    } else if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        isProcessing: sessionState.agentRunning,
        sseClients: this.sseClients.length,
      }))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  }

  // ── POST /api/message ─────────────────────────────────────────────────

  private handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 大小限制：防止超大 payload 导致 OOM
    const MAX_BODY = 1 * 1024 * 1024  // 1MB
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
    if (contentLength > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Payload too large' }))
      return
    }

    // 读取超时：防止慢速客户端永久挂起
    const BODY_TIMEOUT = 5000  // 5s
    const timeout = setTimeout(() => {
      res.writeHead(408, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request timeout' }))
      req.destroy()
    }, BODY_TIMEOUT)

    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      clearTimeout(timeout)
      try {
        const parsed = JSON.parse(body)
        const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''

        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Missing or empty "message" field' }))
          return
        }

        // 入队到 MessageQueue — 和 TUI InputBox 走同一条路径
        this.messageQueue.enqueue(message)
        this.bridge.emitMessage('user', message)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      }
    })
  }

  // ── GET /api/events (SSE) ─────────────────────────────────────────────

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    // 解析 Last-Event-Id（客户端断线重连起点）
    const lastEventIdHeader = req.headers['last-event-id']
    const replayFrom = lastEventIdHeader ? parseInt(String(lastEventIdHeader), 10) || 0 : 0

    // 发送初始连接确认
    const clientId = this.nextClientId++
    this.writeSSEEvent(res, 0, JSON.stringify({ type: 'connected', clientId }))

    const client: SSEClient = { id: clientId, res, replayFrom }
    this.sseClients.push(client)

    // 如果客户端请求了断线重连，先重放缓冲中的历史事件
    if (replayFrom > 0) {
      const catchUp = this.eventRing.filter(e => e.id > replayFrom)
      for (const event of catchUp) {
        this.writeSSEEvent(res, event.id, event.payload)
      }
    }

    // 客户端断开时清理
    req.on('close', () => {
      this.sseClients = this.sseClients.filter(c => c.id !== clientId)
    })
  }

  /** 写入一条带 id 的 SSE 事件 */
  private writeSSEEvent(res: http.ServerResponse, id: number, data: string): void {
    try {
      res.write(`id: ${id}\ndata: ${data}\n\n`)
    } catch {
      // 客户端已断开 — 忽略
    }
  }

  // ── Bridge 事件 → SSE 广播 ────────────────────────────────────────────

  /**
   * 监听 TuiBridge 上的所有关键事件，泛化转发为 SSE JSON。
   * 不做语义转换，客户端自行解析 type 字段。
   */
  private setupBridgeForwarding(): void {
    // 需要广播的 bridge 事件
    const forwardedEvents = new Set([
      'message',        // ChatMessage 格式：{ role, content }
      'text',           // 流式文本 delta
      'turnEnd',        // turn 结束
      'toolStart',      // 工具调用开始
      'toolEnd',        // 工具调用结束
      'status',         // 状态信息
      'usage',          // token 用量
      'compacting',     // 上下文压缩
      'modeChange',     // 模式切换
      'editDiff',       // 文件编辑 diff
      'permission',     // 权限请求（仅通知）
      'question',       // 问题（仅通知）
    ])

    for (const eventName of forwardedEvents) {
      const handler = (data: unknown) => {
        this.eventCounter++
        const eventId = this.eventCounter
        const payload = JSON.stringify({ type: eventName, data })

        // 写入环形缓冲（用于断线重连重放）
        this.eventRing.push({ id: eventId, payload })
        if (this.eventRing.length > RemoteServer.MAX_EVENT_RING) {
          this.eventRing.shift()
        }

        for (const client of this.sseClients) {
          try {
            this.writeSSEEvent(client.res, eventId, payload)
          } catch {
            // 客户端已断开但 close 事件还没触发 — 主动清理
            this.sseClients = this.sseClients.filter(c => c.id !== client.id)
          }
        }
      }
      this.bridgeHandlers.set(eventName, handler)
      this.bridge.on(eventName, handler)
    }
  }
}
