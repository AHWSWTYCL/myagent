/**
 * LSPTool — Language Server Protocol 工具
 *
 * 单工具多操作设计。LLM 通过 operation 参数选择具体操作。
 * 依赖 LSPServerManager 管理 typescript-language-server 生命周期。
 *
 * 支持的操作：
 *   - goToDefinition：跳转到符号定义
 *   - findReferences：查找所有引用
 *   - hover：获取类型信息和文档
 *
 * 结果过滤：goToDefinition 和 findReferences 的结果会通过 git check-ignore
 * 过滤掉 node_modules 等 gitignored 文件，避免返回大量无关结果。
 */

import path from 'path'
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import {
  createLSPServerManager,
  type LSPServerManager,
} from '../lsp/LSPServerManager.js'
import type {
  Location,
  LocationLink,
  Hover,
  MarkupContent,
} from 'vscode-languageserver-types'

const execFileAsync = promisify(execFile)

// ── LSPTool ───────────────────────────────────────────────────────────────────

export class LSPTool extends Tool {
  constructor(
    private manager: LSPServerManager,
  ) {
    super()
  }

  get name(): string {
    return 'lsp'
  }

  get description(): string {
    return [
      'Language Server Protocol — code intelligence operations.',
      'Supports: goToDefinition, findReferences, hover.',
      'Use grep first to find line/character positions (grep output includes line numbers).',
      'line and character are 1-based (as shown in editors).',
    ].join(' ')
  }

  get inputSchemaZod() {
    return z.object({
      operation: z
        .enum(['goToDefinition', 'findReferences', 'hover'])
        .describe('The LSP operation to perform'),
      filePath: z.string().describe('Absolute or relative file path'),
      line: z.number().int().positive()
        .describe('The line number (1-based, as shown in editors and grep output)'),
      character: z.number().int().positive()
        .describe('The character offset (1-based, as shown in editors)'),
    })
  }

  get outputSchemaZod() {
    return z.string()
  }

  get parallelSafe(): boolean {
    return true
  }

  get isExplorationTool(): boolean {
    return true
  }

  get toolLabel(): string {
    return 'LSP'
  }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const op = String(input.operation ?? '')
    const fp = Tool.shortPath(String(input.filePath ?? ''))
    const line = input.line ?? ''
    const ch = input.character ?? ''
    return {
      label: 'LSP',
      args: `${op} ${fp}:${line}:${ch}`,
    }
  }

  renderToolResult(output: string, isError: boolean): string[] {
    if (isError) return Tool.summarize(output, true)
    const lines = output.trim().split('\n')
    return lines.length <= 4 ? lines : [`${lines.length} lines`, lines[0]!, '…']
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    // 所有 LSP 操作都是只读的
    return { action: 'continue' }
  }

  /**
   * 检测 typescript-language-server 是否可用。
   * 如果不可用，bootstrap 应跳过注册此工具。
   */
  static isServerAvailable(): boolean {
    // 检查 node_modules 中是否有 typescript-language-server
    // 或全局安装
    try {
      execSync('npx typescript-language-server --version', {
        stdio: 'ignore',
        timeout: 5000,
      })
      return true
    } catch {
      return false
    }
  }

  async execute(args: {
    operation: string
    filePath: string
    line: number
    character: number
  }): Promise<string> {
    const { operation, filePath, line, character } = args
    const resolvedPath = path.resolve(filePath)

    // 坐标转换：1-based（用户输入）→ 0-based（LSP 协议）
    const position = {
      line: line - 1,
      character: character - 1,
    }

    try {
      switch (operation) {
        case 'goToDefinition':
          return await this.goToDefinition(resolvedPath, position)
        case 'findReferences':
          return await this.findReferences(resolvedPath, position)
        case 'hover':
          return await this.hover(resolvedPath, position)
        default:
          return `Error: unknown operation "${operation}". Supported: goToDefinition, findReferences, hover`
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error: ${msg}`
    }
  }

  // ── 各操作实现 ──────────────────────────────────────────────────────────

  private async goToDefinition(
    filePath: string,
    position: { line: number; character: number },
  ): Promise<string> {
    const uri = pathToFileURL(filePath).href

    const result = await this.manager.sendRequest<Location | Location[] | LocationLink[] | null>(
      filePath,
      'textDocument/definition',
      { textDocument: { uri }, position },
    )

    if (!result) return 'No definition found.'

    // 归一化为 Location[]
    let locations = this.toLocations(result)
    if (locations.length === 0) return 'No definition found.'

    // 过滤 gitignored 文件（如 node_modules）
    locations = await filterGitIgnoredLocations(locations)

    return locations
      .map((loc) => this.formatLocation(loc, '→'))
      .join('\n')
  }

  private async findReferences(
    filePath: string,
    position: { line: number; character: number },
  ): Promise<string> {
    const uri = pathToFileURL(filePath).href

    const result = await this.manager.sendRequest<Location[] | null>(
      filePath,
      'textDocument/references',
      {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      },
    )

    if (!result || result.length === 0) return 'No references found.'

    // 过滤 gitignored 文件（如 node_modules）
    const originalCount = result.length
    const filtered = await filterGitIgnoredLocations(result)
    const filteredCount = originalCount - filtered.length

    if (filtered.length === 0) {
      return `No references found in tracked files. (${originalCount} reference${originalCount === 1 ? '' : 's'} found in gitignored files like node_modules — excluded.)`
    }

    const lines = filtered.map((loc, i) =>
      `  ${i + 1}. ${this.formatLocation(loc)}`,
    )
    const header = `Found ${filtered.length} reference${filtered.length === 1 ? '' : 's'}`
    const suffix = filteredCount > 0 ? ` (${filteredCount} gitignored reference${filteredCount === 1 ? '' : 's'} excluded)` : ''
    return [header + suffix + ':', ...lines].join('\n')
  }

  private async hover(
    filePath: string,
    position: { line: number; character: number },
  ): Promise<string> {
    const uri = pathToFileURL(filePath).href

    const result = await this.manager.sendRequest<Hover | null>(
      filePath,
      'textDocument/hover',
      { textDocument: { uri }, position },
    )

    if (!result) return 'No hover information available.'

    const contents = result.contents

    // MarkupContent
    if (this.isMarkupContent(contents)) {
      return contents.value
    }

    // MarkedString | MarkedString[]
    if (Array.isArray(contents)) {
      return contents
        .map((m) => (typeof m === 'string' ? m : m.value))
        .join('\n\n')
    }

    // MarkedString
    if (typeof contents === 'string') {
      return contents
    }

    return String(contents)
  }

  // ── 格式化工具 ──────────────────────────────────────────────────────────

  /** 将 LSP Location/LocationLink 归一化为 Location[] */
  private toLocations(
    result: Location | Location[] | LocationLink[] | null,
  ): Location[] {
    if (!result) return []
    if (Array.isArray(result)) {
      return result.map((item) => {
        if ('targetUri' in item) {
          // LocationLink → Location
          return {
            uri: item.targetUri,
            range: item.targetSelectionRange,
          }
        }
        return item // already Location
      })
    }
    return [result]
  }

  /** 格式化一个 Location 为可读字符串 */
  private formatLocation(loc: Location, prefix?: string): string {
    const filePath = this.uriToPath(loc.uri)
    const start = loc.range.start
    const line = start.line + 1 // 0-based → 1-based
    const ch = start.character + 1
    const pre = prefix ? `${prefix} ` : ''
    return `${pre}${filePath}:${line}:${ch}`
  }

  /** file:// URI → 相对路径 */
  private uriToPath(uri: string): string {
    let p = uri.replace(/^file:\/\//, '')
    // Windows: /C:/path → C:/path
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    try {
      p = decodeURIComponent(p)
    } catch {
      // 保持原样
    }

    // 相对于 cwd
    const cwd = process.cwd()
    if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1)
    if (p === cwd) return '.'
    return p
  }

  private isMarkupContent(
    contents: unknown,
  ): contents is MarkupContent {
    return (
      typeof contents === 'object' &&
      contents !== null &&
      'kind' in contents &&
      'value' in contents
    )
  }
}

// ── Gitignore 过滤 ────────────────────────────────────────────────────────────

/**
 * 从 Location 数组中提取文件路径（用于 git check-ignore 批处理）。
 */
function locationToFilePath(loc: Location): string {
  let p = loc.uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // Windows
  try { p = decodeURIComponent(p) } catch { /* keep as-is */ }
  return p
}

/**
 * 用 `git check-ignore` 批量检查路径是否被 gitignore。
 * 
 * 每次最多传 50 个路径，5s 超时。
 * 非 git 仓库 / git check-ignore 不可用时，不过滤任何结果。
 * 
 * 参考：Claude Code 的 filterGitIgnoredLocations()
 */
async function filterGitIgnoredLocations<T extends Location>(
  locations: T[],
): Promise<T[]> {
  if (locations.length === 0) return locations

  // 收集唯一文件路径
  const uriToFilePath = new Map<string, string>()
  for (const loc of locations) {
    if (loc.uri && !uriToFilePath.has(loc.uri)) {
      uriToFilePath.set(loc.uri, locationToFilePath(loc))
    }
  }

  const uniquePaths = [...new Set(uriToFilePath.values())]
  if (uniquePaths.length === 0) return locations

  // 批量 git check-ignore（每批 50 个，5s 超时）
  const ignoredPaths = new Set<string>()
  const BATCH_SIZE = 50

  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE)
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['check-ignore', ...batch],
        { timeout: 5_000 },
      )
      for (const line of stdout.trim().split('\n')) {
        const trimmed = line.trim()
        if (trimmed) ignoredPaths.add(trimmed)
      }
    } catch (err: any) {
      // exit code 1 = none ignored（正常）
      // exit code 128 = not a git repo → 不过滤
      // 其他错误 → 不过滤（安全兜底）
      if (err.code === 1 || err.stdout) {
        // code 1 但可能有部分匹配（git check-ignore 行为：全部未匹配才 exit 1）
        // 不过不会有 stdout，因为 exit 1 意味着至少一个未忽略
        continue
      }
      // 非 git 仓库或错误 → 不过滤
      if (err.code === 128) return locations
      // 其他异常 → 不过滤，安全第一
      return locations
    }
  }

  if (ignoredPaths.size === 0) return locations

  // 过滤掉 gitignored 路径
  return locations.filter(loc => {
    const filePath = uriToFilePath.get(loc.uri)
    return !filePath || !ignoredPaths.has(filePath)
  })
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function pathToFileURL(filePath: string): URL {
  // 跨平台 file:// URI
  let p = path.resolve(filePath).replace(/\\/g, '/')
  if (!p.startsWith('/')) p = '/' + p
  return new URL('file://' + p)
}
