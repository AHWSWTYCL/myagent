/**
 * LSPServerManager — LSP 服务器生命周期管理
 *
 * 管理 typescript-language-server 的启动、文件同步和请求路由。
 * MVP 硬编码 TS server 配置，后续可扩展 ~/.myagent/lsp.json。
 *
 * 关键设计：
 *   - 懒启动：首次访问时才 spawn，避免闲置进程
 *   - 崩溃恢复：crash 后下次调用自动重启（最多 3 次）
 *   - 文件同步：复用 fileStateCache 做 didOpen，避免重复 I/O
 *   - 5MB 上限：超大文件拒绝
 */

import * as path from 'path'
import { pathToFileURL } from 'url'
import fs from 'fs'
import { createLSPClient, type LSPClient, type ServerCapabilities, type InitializeParams } from './LSPClient.js'
import { fileStateCache } from '../utils/fileStateCache.js'

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface LSPServerManager {
  ensureStarted(filePath: string): Promise<void>
  sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T>
  openFile(filePath: string): Promise<void>
  /** 通知 LSP 文件内容变更（didChange） */
  changeFile(filePath: string, content: string): Promise<void>
  /** 通知 LSP 文件已保存（didSave，触发重新诊断） */
  saveFile(filePath: string): Promise<void>
  /** 获取收集到的诊断并清空 */
  getDiagnostics(): string
  shutdown(): Promise<void>
  isRunning(): boolean
  getCapabilities(): ServerCapabilities | undefined
}

// ── 配置 ──────────────────────────────────────────────────────────────────────

const TS_SERVER_CONFIG = {
  command: 'npx',
  args: ['typescript-language-server', '--stdio'],
  extensionToLanguage: {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
  } as Record<string, string>,
}

const MAX_FILE_SIZE_BYTES = 5_000_000 // 5MB
const STARTUP_TIMEOUT_MS = 15_000
const MAX_CRASH_RECOVERY = 3

// ── 工厂函数 ──────────────────────────────────────────────────────────────────

export function createLSPServerManager(): LSPServerManager {
  let client: LSPClient | undefined
  let state: string = 'stopped'  // 'stopped' | 'starting' | 'running' | 'error'
  let crashCount = 0
  let capabilities: ServerCapabilities | undefined
  // 诊断收集（publishDiagnostics 通知 → 文本队列）
  const diagnostics: string[] = []
  const MAX_DIAGNOSTICS = 20

  // 已打开的文件追踪（URI → true），避免重复 didOpen
  const openedFiles = new Set<string>()

  // 共享启动 promise：非 null 表示正在启动，并发调用者 await 同一个 promise 等待完成
  let startupPromise: Promise<void> | null = null

  return {
    getCapabilities() {
      return capabilities
    },

    isRunning() {
      return state === 'running'
    },

    async ensureStarted(filePath: string) {
      // 检查是否有可用 server
      const ext = path.extname(filePath).toLowerCase()
      if (!TS_SERVER_CONFIG.extensionToLanguage[ext]) {
        return // 不支持的文件类型，静默跳过
      }

      // 已运行 → 直接返回
      if (state === 'running') return

      // 正在启动 → 共享启动 promise，等它完成
      if (startupPromise) {
        await startupPromise
        return
      }

      // 崩溃次数超限
      if (state === 'error' && crashCount > MAX_CRASH_RECOVERY) {
        throw new Error(
          `LSP server crashed ${crashCount} times (max ${MAX_CRASH_RECOVERY}). ` +
          `Check if typescript-language-server is installed: npm i -g typescript-language-server`
        )
      }

      state = 'starting'

      // 将整个启动流程包进共享 promise，并发调用者 await 同一个 promise
      startupPromise = (async () => {
        try {
          client = createLSPClient('ts-ls')

          // 带超时的 start
          const startPromise = client.start(
            TS_SERVER_CONFIG.command,
            TS_SERVER_CONFIG.args,
          )
          await withTimeout(startPromise, STARTUP_TIMEOUT_MS, 'LSP server start timeout')

          // initialize
          const workspaceFolder = process.cwd()
          const workspaceUri = pathToFileURL(workspaceFolder).href

          const initParams: InitializeParams = {
            processId: process.pid,
            rootUri: workspaceUri,
            workspaceFolders: [{ uri: workspaceUri, name: path.basename(workspaceFolder) }],
            capabilities: {
              textDocument: {
                definition: { linkSupport: true },
                references: {},
                hover: { contentFormat: ['markdown', 'plaintext'] },
              },
            },
          }

          await client.initialize(initParams)
          capabilities = client.capabilities

          // 注册 publishDiagnostics 处理器
          client.onNotification('textDocument/publishDiagnostics', (params: any) => {
            if (!params?.diagnostics?.length) return
            const uri = params.uri || ''
            const filePath = uri.replace(/^file:\/\//, '')
            const fileName = path.basename(filePath) || uri

            for (const d of params.diagnostics) {
              if (diagnostics.length >= MAX_DIAGNOSTICS) break
              const sevKey = (d.severity as number) ?? 1
              const sev = { 1: '❌', 2: '⚠️', 3: 'ℹ️', 4: '💡' }[sevKey] ?? '❌'
              const line = d.range?.start?.line ?? 0
              const msg = d.message
              diagnostics.push(`${sev} ${fileName}:${line + 1} — ${msg}`)
            }
          })

          state = 'running'
          crashCount = 0
          console.log(`[lsp] typescript-language-server started successfully`)
        } catch (err) {
          state = 'error'
          crashCount++
          // 清理失败的 client
          client?.stop().catch(() => {})
          client = undefined
          throw err
        } finally {
          startupPromise = null  // 清空，允许下次重试
        }
      })()

      await startupPromise
    },

    async openFile(filePath: string) {
      const resolvedPath = path.resolve(filePath)
      const fileUri = pathToFileURL(resolvedPath).href

      // 已打开 → 跳过
      if (openedFiles.has(fileUri)) return
      if (state !== 'running' || !client) return

      // 从 fileStateCache 取内容
      const cached = fileStateCache.get(resolvedPath)
      let content: string
      if (cached) {
        content = cached.content
      } else {
        // fallback：读磁盘
        try {
          const stat = fs.statSync(resolvedPath)
          if (stat.size > MAX_FILE_SIZE_BYTES) {
            console.warn(`[lsp] file too large for LSP: ${filePath} (${stat.size} bytes)`)
            return
          }
          content = fs.readFileSync(resolvedPath, 'utf-8')
        } catch {
          return // 文件不存在，跳过
        }
      }

      // 大小检查
      if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE_BYTES) {
        console.warn(`[lsp] file too large for LSP: ${filePath}`)
        return
      }

      const ext = path.extname(filePath).toLowerCase()
      const languageId = TS_SERVER_CONFIG.extensionToLanguage[ext] || 'plaintext'

      try {
        await client.sendNotification('textDocument/didOpen', {
          textDocument: {
            uri: fileUri,
            languageId,
            version: 1,
            text: content,
          },
        })
        openedFiles.add(fileUri)
      } catch (err) {
        console.warn(`[lsp] didOpen failed for ${filePath}: ${err}`)
      }
    },

    async sendRequest<T>(filePath: string, method: string, params: unknown): Promise<T> {
      await this.ensureStarted(filePath)
      await this.openFile(filePath)

      if (!client) {
        const ext = path.extname(filePath).toLowerCase()
        if (!TS_SERVER_CONFIG.extensionToLanguage[ext]) {
          throw new Error(`No LSP server available for "${ext}" files. Only TypeScript/JavaScript is supported in MVP.`)
        }
        throw new Error('LSP server not available. Check if typescript-language-server is installed.')
      }

      return client.sendRequest<T>(method, params)
    },

    async changeFile(filePath: string, content: string) {
      if (state !== 'running' || !client) return
      const resolvedPath = path.resolve(filePath)
      const fileUri = pathToFileURL(resolvedPath).href

      // 如果未 didOpen，先 didOpen
      if (!openedFiles.has(fileUri)) {
        await this.openFile(filePath)
      }

      try {
        await client.sendNotification('textDocument/didChange', {
          textDocument: { uri: fileUri, version: 1 },
          contentChanges: [{ text: content }],
        })
      } catch {
        // fire-and-forget
      }
    },

    async saveFile(filePath: string) {
      if (state !== 'running' || !client) return
      const fileUri = pathToFileURL(path.resolve(filePath)).href

      try {
        await client.sendNotification('textDocument/didSave', {
          textDocument: { uri: fileUri },
        })
      } catch {
        // fire-and-forget
      }
    },

    getDiagnostics(): string {
      if (diagnostics.length === 0) return ''
      const result = diagnostics.splice(0).join('\n')
      return result
    },

    async shutdown() {
      if (client) {
        await client.stop()
        client = undefined
      }
      state = 'stopped'
      openedFiles.clear()
    },
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
}
