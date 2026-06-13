/**
 * MCP 传输层抽象
 *
 * 定义 MCPTransport 接口，提供 StdioTransport（子进程）和 SSETransport（HTTP SSE）两种实现。
 * 所有异常通过回调传递，不抛异常到上层。
 */

import { spawn, ChildProcess } from 'child_process'

// ── stdio 日志收集 ────────────────────────────────────────────────────────────

/** 模块级 sink：设置后 stdio 日志不再走 console.warn，改为回调 */
let stdioLogSink: ((line: string) => void) | null = null

/**
 * 设置 stdio 日志回调。
 * 传入 null 恢复默认行为（console.warn）。
 */
export function setStdioLogSink(sink: ((line: string) => void) | null): void {
  stdioLogSink = sink
}

// ── 传输接口 ──────────────────────────────────────────────────────────────────

export interface MCPTransport {
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(message: string): Promise<void>
  isConnected(): boolean
  onMessage(cb: (data: string) => void): void
  onError(cb: (err: Error) => void): void
  onClose(cb: () => void): void
}

// ── stdio 传输 ─────────────────────────────────────────────────────────────────

export interface StdioTransportOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 子进程启动超时（毫秒），默认 10_000 */
  startupTimeout?: number
}

/**
 * 通过 child_process.spawn 启动 MCP Server 子进程，
 * 通过 stdin/stdout 收发 JSON-RPC 消息。
 *
 * stderr 的日志输出到 console.warn，不影响主流程。
 */
export class StdioTransport implements MCPTransport {
  private process: ChildProcess | null = null
  private buffer = ''
  private _onMessage: ((data: string) => void) | null = null
  private _onError: ((err: Error) => void) | null = null
  private _onClose: (() => void) | null = null
  private _connected = false
  private _closing = false
  private options: StdioTransportOptions

  constructor(options: StdioTransportOptions) {
    this.options = options
  }

  onMessage(cb: (data: string) => void): void { this._onMessage = cb }
  onError(cb: (err: Error) => void): void { this._onError = cb }
  onClose(cb: () => void): void { this._onClose = cb }

  isConnected(): boolean { return this._connected }

  async connect(): Promise<void> {
    if (this.process) return

    const { command, args = [], env, startupTimeout = 10_000 } = this.options

    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env ? { ...process.env, ...env } : process.env,
        shell: false,
      })
      this.process = child

      // 超时处理
      const timer = setTimeout(() => {
        if (!this._connected) {
          child.kill()
          reject(new Error(`Startup timeout: ${command} did not connect within ${startupTimeout}ms`))
        }
      }, startupTimeout)

      // stdout — 逐行读取 JSON-RPC 消息
      child.stdout?.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf-8')
        this.processBuffer()
      })

      // stderr — 仅做日志，不中断流程
      child.stderr?.on('data', (chunk: Buffer) => {
        const line = `[mcp:stdio] ${chunk.toString('utf-8').trimEnd()}`
        if (stdioLogSink) { stdioLogSink(line) } else { console.warn(line) }
      })

      // 进程退出
      child.on('exit', (code, signal) => {
        this._connected = false
        this.process = null
        const reason = signal
          ? `killed by signal ${signal}`
          : `exited with code ${code}`
        const line = `[mcp:stdio] process ${reason}`
        if (stdioLogSink) { stdioLogSink(line) } else { console.warn(line) }
        if (!this._closing) {
          this._onClose?.()
        }
      })

      child.on('error', (err) => {
        this._connected = false
        this.process = null
        clearTimeout(timer)
        this._onError?.(err)
        reject(err)
      })

      // 进程成功启动后标记连接
      // 注意：子进程可能在握手后才真正"就绪"，但这里只保证进程已 spawn
      child.on('spawn', () => {
        this._connected = true
        clearTimeout(timer)
        resolve()
      })

      // 如果 'spawn' 事件不支持（旧版 Node.js），fallback 到下一个 tick
      if (child.pid !== undefined) {
        setImmediate(() => {
          if (!this._connected && child.exitCode === null && child.killed === false) {
            this._connected = true
            clearTimeout(timer)
            resolve()
          }
        })
      }
    })
  }

  async disconnect(): Promise<void> {
    this._closing = true
    if (this.process) {
      // SIGTERM → 等待 3 秒 → SIGKILL
      this.process.kill('SIGTERM')
      return new Promise<void>((resolve) => {
        const forceKill = setTimeout(() => {
          try { this.process?.kill('SIGKILL') } catch { /* ignore */ }
        }, 3000)
        this.process?.on('exit', () => {
          clearTimeout(forceKill)
          this._connected = false
          this.process = null
          resolve()
        })
        // 如果进程已经退出了
        if (this.process?.exitCode !== null || this.process?.killed) {
          clearTimeout(forceKill)
          this._connected = false
          this.process = null
          resolve()
        }
      })
    }
    this._connected = false
  }

  async send(message: string): Promise<void> {
    if (!this.process?.stdin || !this._connected) {
      throw new Error('Transport not connected')
    }
    return new Promise<void>((resolve, reject) => {
      this.process!.stdin!.write(message + '\n', (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /** 解析缓冲区中的完整 JSON-RPC 消息（按行分割） */
  private processBuffer(): void {
    while (true) {
      const nlIndex = this.buffer.indexOf('\n')
      if (nlIndex === -1) break

      const line = this.buffer.slice(0, nlIndex).trim()
      this.buffer = this.buffer.slice(nlIndex + 1)

      if (line.length === 0) continue

      this._onMessage?.(line)
    }
  }
}

// ── SSE 传输 ──────────────────────────────────────────────────────────────────

export interface SSETransportOptions {
  url: string
  headers?: Record<string, string>
  /** SSE 连接超时（毫秒），默认 10_000 */
  connectTimeout?: number
  /** 工具调用超时（毫秒），默认 30_000 */
  requestTimeout?: number
}

/**
 * 通过 Server-Sent Events 连接 MCP Server。
 * - 通过 fetch 建立 SSE 流，解析 event stream 中的消息
 * - 通过 HTTP POST 发送 JSON-RPC 请求
 */
export class SSETransport implements MCPTransport {
  private url: string
  private headers: Record<string, string>
  private connectTimeout: number
  private requestTimeout: number
  private abortController: AbortController | null = null
  private _onMessage: ((data: string) => void) | null = null
  private _onError: ((err: Error) => void) | null = null
  private _onClose: (() => void) | null = null
  private _connected = false

  /** SSE endpoint（从初始 URL 获取） */
  private sessionUrl: string | null = null

  constructor(options: SSETransportOptions) {
    this.url = options.url
    this.headers = options.headers ?? {}
    this.connectTimeout = options.connectTimeout ?? 10_000
    this.requestTimeout = options.requestTimeout ?? 30_000
  }

  onMessage(cb: (data: string) => void): void { this._onMessage = cb }
  onError(cb: (err: Error) => void): void { this._onError = cb }
  onClose(cb: () => void): void { this._onClose = cb }

  isConnected(): boolean { return this._connected }

  async connect(): Promise<void> {
    if (this._connected) return

    this.abortController = new AbortController()
    const { signal } = this.abortController

    try {
      // 第一步：建立 SSE 连接
      const timeoutTimer = setTimeout(() => {
        this.abortController?.abort()
      }, this.connectTimeout)

      const response = await fetch(this.url, {
        signal,
        headers: {
          Accept: 'text/event-stream',
          ...this.headers,
        },
      })
      clearTimeout(timeoutTimer)

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`)
      }

      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('SSE response body is not readable')
      }

      // 使用异步生成器统一解析 SSE 事件流。
      // 先从生成器获取首个事件：必须是 endpoint 事件，以获取 POST 地址。
      // 否则 connect() 返回后 send() 会因 sessionUrl 为 null 而 fallback 到错误 URL。
      const events = this.parseSSEEvents(reader)

      // 等待首个 endpoint 事件
      const first = await events.next()
      if (first.done) {
        throw new Error('SSE stream ended before receiving endpoint event')
      }
      // 首个事件必须是 endpoint（VSCode 等 MCP Server 的标准行为）
      if (first.value.event === 'endpoint') {
        this.dispatchEvent(first.value)
      }

      // 如果第一个事件不是 endpoint（某些非标实现），再读一个试试
      if (!this.sessionUrl) {
        const second = await events.next()
        if (!second.done && second.value.event === 'endpoint') {
          this.dispatchEvent(second.value)
        }
      }

      if (!this.sessionUrl) {
        throw new Error('SSE stream did not send an endpoint event')
      }

      this._connected = true

      // 后台持续消费后续 SSE 事件
      this.consumeSSEEvents(events)
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this._onError?.(new Error(`SSE connection timeout after ${this.connectTimeout}ms`))
      } else {
        this._onError?.(err instanceof Error ? err : new Error(String(err)))
      }
      this._connected = false
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this._connected = false
    // abort() 标记 signal.aborted=true，consumeSSEEvents 的 finally 会检查此标记
    // 跳过 _onClose 触发（由本方法统一触发），避免重复
    this.abortController?.abort()
    this.sessionUrl = null
    this._onClose?.()
  }

  async send(message: string): Promise<void> {
    if (!this._connected) {
      throw new Error('SSE transport not connected')
    }

    // 从 SSE 连接中获取 session URL（通常在 endpoint 事件中）
    // 如果没有获取到，回退到 POST 到 base URL
    const targetUrl = this.sessionUrl ?? this.url

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: message,
      signal: AbortSignal.timeout(this.requestTimeout),
    })

    if (!response.ok) {
      throw new Error(`SSE POST failed: ${response.status} ${response.statusText}`)
    }

    // 如果 POST 返回了 JSON-RPC 响应体，处理它
    const text = await response.text().catch(() => '')
    if (text.trim()) {
      this._onMessage?.(text)
    }
  }

  /** 异步生成器：逐事件产出 SSE 事件流 */
  private async *parseSSEEvents(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): AsyncGenerator<{ event: string; data: string }> {
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''
    let currentData = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        while (true) {
          const nlIndex = buffer.indexOf('\n')
          if (nlIndex === -1) break

          const line = buffer.slice(0, nlIndex)
          buffer = buffer.slice(nlIndex + 1)

          // 空行 = 事件结束
          if (line === '') {
            if (currentData) {
              yield { event: currentEvent || '', data: currentData.trim() }
            }
            currentEvent = ''
            currentData = ''
            continue
          }

          // 解析 event 字段
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
            continue
          }

          // 解析 data 字段
          if (line.startsWith('data: ')) {
            currentData += (currentData ? '\n' : '') + line.slice(6)
            continue
          }

          // 忽略其他字段（如 id、retry）
        }
      }

      // 处理最后一块数据
      if (currentData) {
        yield { event: currentEvent || '', data: currentData.trim() }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** 后台消费 SSE 事件生成器，分发到 dispatchEvent */
  private async consumeSSEEvents(
    events: AsyncGenerator<{ event: string; data: string }>,
  ): Promise<void> {
    try {
      for await (const ev of events) {
        this.dispatchEvent(ev)
      }
    } catch (err: any) {
      if (!this.abortController?.signal.aborted) {
        this._onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      // 非主动断开（如网络中断、服务端关闭）时才触发 onClose
      // disconnect() 本身由外部显式调用，不应在此重复触发
      if (!this.abortController?.signal.aborted) {
        this._connected = false
        this._onClose?.()
      }
    }
  }

  /** 分发单个 SSE 事件 */
  private dispatchEvent(ev: { event: string; data: string }): void {
    if (ev.event === 'endpoint') {
      // 规范化 sessionUrl：处理相对路径
      try {
        this.sessionUrl = new URL(ev.data, this.url).toString()
      } catch {
        this._onError?.(new Error(`Invalid endpoint URL from SSE: ${ev.data}`))
      }
      return
    }

    // message 或无 event 字段 → JSON-RPC 消息
    if (ev.event === 'message' || !ev.event) {
      this._onMessage?.(ev.data)
      return
    }

    // 其他事件类型也作为消息传递
    this._onMessage?.(ev.data)
  }
}
