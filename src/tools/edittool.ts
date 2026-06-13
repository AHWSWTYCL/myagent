import fs from 'fs'
import path from 'path'
import { structuredPatch } from 'diff'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool'
import { fileStateCache } from '../utils/fileStateCache.js'
import { getLSPManager } from '../lsp/index.js'

// ── 导出类型供 TUI / LoggerHook 使用 ─────────────────────────────────────

export interface DiffLine {
  type: 'add' | 'remove' | 'context'
  content: string
  oldLine: number | null
  newLine: number | null
}

export interface EditDiffResult {
  filePath: string
  lines: DiffLine[]
  additions: number
  removals: number
}

// ── 花引号常量（Claude 无法生成花引号，定义为常量供 prompt 引用） ──────
export const LEFT_SINGLE_CURLY_QUOTE = '\u2018'
export const RIGHT_SINGLE_CURLY_QUOTE = '\u2019'
export const LEFT_DOUBLE_CURLY_QUOTE = '\u201C'
export const RIGHT_DOUBLE_CURLY_QUOTE = '\u201D'

// ── 去污化映射：API 层对某些字符串做了转义，模型输出的是转义后的版本 ──
const DESANITIZATIONS: Record<string, string> = {
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '<META_START>',
  '< META_END >': '<META_END>',
  '< EOT >': '<EOT>',
  '< META >': '<META>',
  '< SOS >': '<SOS>',
  '\n\nH:': '\n\nHuman:',
  '\n\nA:': '\n\nAssistant:',
}

// ── 引号归一化 ──────────────────────────────────────────────────────────────

/** 花引号 → 直引号 */
function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

/**
 * 在文件中查找实际匹配的字符串。
 * 1. 精确匹配
 * 2. 引号归一化后匹配（LLM 可能输出直引号，但文件中有花引号）
 */
function findActualString(fileContent: string, searchString: string): string | null {
  // 第一遍：精确匹配
  if (fileContent.includes(searchString)) return searchString

  // 第二遍：引号归一化后匹配
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex !== -1) {
    // 返回文件中的实际子串（保持原始引号风格）
    return fileContent.substring(searchIndex, searchIndex + searchString.length)
  }

  return null
}

/**
 * 对 new_string 应用与文件中一致的引号风格。
 * 当通过引号归一化匹配到 old_string 后，new_string 中的直引号
 * 应替换为文件中使用的花引号风格。
 */
function preserveQuoteStyle(oldString: string, actualOldString: string, newString: string): string {
  if (oldString === actualOldString) return newString // 没有归一化，直接返回

  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

  if (!hasDoubleQuotes && !hasSingleQuotes) return newString

  let result = newString
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result)
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result)
  return result
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true
  const prev = chars[index - 1]!
  return ' \t\n\r([{'.includes(prev) || prev === '\u2014' || prev === '\u2013'
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  return chars.map((ch, i) => {
    if (ch !== '"') return ch
    return isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE
  }).join('')
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  return chars.map((ch, i) => {
    if (ch !== "'") return ch
    // 缩写的撇号（don't, it's）保持为直引号
    const prev = i > 0 ? chars[i - 1] : undefined
    const next = i < chars.length - 1 ? chars[i + 1] : undefined
    if (prev !== undefined && next !== undefined && /\p{L}/u.test(prev) && /\p{L}/u.test(next)) {
      return RIGHT_SINGLE_CURLY_QUOTE
    }
    return isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE
  }).join('')
}

// ── 去污化 ──────────────────────────────────────────────────────────────────

function desanitizeMatchString(matchString: string): { result: string; applied: Array<{ from: string; to: string }> } {
  let result = matchString
  const applied: Array<{ from: string; to: string }> = []
  for (const [from, to] of Object.entries(DESANITIZATIONS)) {
    const before = result
    result = result.replaceAll(from, to)
    if (before !== result) applied.push({ from, to })
  }
  return { result, applied }
}

// ── 尾随空白清理（非 Markdown 文件） ───────────────────────────────────────

function stripTrailingWhitespace(str: string): string {
  return str.split(/(\r\n|\n|\r)/).map((part, i) => i % 2 === 0 ? part.replace(/\s+$/, '') : part).join('')
}

// ── Diff 生成 ────────────────────────────────────────────────────────────────

function computeDiff(filePath: string, originalContent: string, updated: string): EditDiffResult {
  const patch = structuredPatch(filePath, filePath, originalContent, updated, undefined, undefined, { context: 3 })
  const lines: DiffLine[] = []
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const line of hunk.lines) {
      const ch = line[0]
      const text = line.slice(1)
      if (ch === ' ') {
        lines.push({ type: 'context', content: text, oldLine, newLine })
        oldLine++; newLine++
      } else if (ch === '-') {
        lines.push({ type: 'remove', content: text, oldLine, newLine: null })
        oldLine++
      } else if (ch === '+') {
        lines.push({ type: 'add', content: text, oldLine: null, newLine })
        newLine++
      }
    }
  }
  const additions = lines.filter(l => l.type === 'add').length
  const removals = lines.filter(l => l.type === 'remove').length
  return { filePath, lines, additions, removals }
}

// ── Tool 实现 ────────────────────────────────────────────────────────────────

export class EditTool extends Tool {

  get name(): string {
    return 'edit_file'
  }

  get description(): string {
    return 'Performs exact string replacements in files. ' +
      'You must use read_file at least once before editing. ' +
      'The edit will FAIL if old_string is not unique in the file. ' +
      'Either provide a larger string with more surrounding context to make it unique ' +
      'or use replace_all to change every instance.'
  }

  get inputSchemaZod() {
    return z.object({
      file_path: z.string().describe('Absolute or relative file path'),
      old_string: z.string().describe('The exact text to replace'),
      new_string: z.string().describe('The new text to insert'),
      replace_all: z.boolean().default(false).optional()
        .describe('Replace all occurrences of old_string (default false)'),
    })
  }

  get outputSchemaZod() {
    return z.string()
  }

  get toolLabel(): string {
    return 'Edit'
  }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    return { label: 'Edit', args: Tool.shortPath(String(input.file_path ?? input.path ?? '')) }
  }

  renderToolResult(_output: string, isError: boolean): string[] {
    if (isError) return Tool.summarize(_output, true)
    return []
  }

  async execute(args: any): Promise<string> {
    const filePath = args.file_path ?? args.path
    const oldString = args.old_string
    const newString = args.new_string
    const replaceAll = args.replace_all === true

    const resolvedPath = path.resolve(filePath)

    // ── 1. 读前检查 ────────────────────────────────────────────────────
    const cached = fileStateCache.get(resolvedPath)
    if (!cached) {
      return `Error: File has not been read yet. Read it first with read_file before editing.\nFile: ${filePath}`
    }

    // ── 2. 读文件（当前磁盘上的内容） ─────────────────────────────────
    let currentContent: string
    try {
      currentContent = fs.readFileSync(resolvedPath, 'utf-8')
    } catch (err: any) {
      return `Error reading file: ${err.message ?? err}`
    }

    // ── 3. 文件过时检查 ────────────────────────────────────────────────
    try {
      const currentMtime = fs.statSync(resolvedPath).mtimeMs
      if (currentMtime > cached.timestamp) {
        // Windows 上 timestamp 可能因云同步/杀毒软件变化而不改变内容
        if (currentContent !== cached.content) {
          return `Error: File has been modified since read. Read it again with read_file before attempting to edit it.\nFile: ${filePath}`
        }
      }
    } catch {
      // stat 失败（文件被删除等）— 放行，write 阶段会报错
    }

    // ── 4. 去污化 + 引号归一化匹配 old_string ────────────────────────
    // 先尝试精确匹配
    let actualOldString = findActualString(currentContent, oldString)

    // 如果精确匹配 + norm 匹配均失败，尝试去污化后再匹配
    if (!actualOldString) {
      const { result: desanitized, applied } = desanitizeMatchString(oldString)
      if (desanitized !== oldString) {
        actualOldString = findActualString(currentContent, desanitized)
        if (actualOldString === desanitized) {
          // 去污化后匹配成功且不需要 norm — 保持 actualOldString
        } else if (actualOldString) {
          // 去污化后通过 norm 匹配成功
        }
        // 如果去污化后也未找到，不覆盖 actualOldString（保持 null）
      }
    }

    if (!actualOldString) {
      return `Error: String to replace not found in file.\nFile: ${filePath}\nString: ${oldString}`
    }

    // ── 5. 匹配次数检查 ────────────────────────────────────────────────
    const matchCount = currentContent.split(actualOldString).length - 1
    if (matchCount === 0) {
      return `Error: String to replace not found in file.\nFile: ${filePath}\nString: ${oldString}`
    }
    if (matchCount > 1 && !replaceAll) {
      return `Error: Found ${matchCount} matches of the string to replace, but replace_all is false. ` +
        `To replace all occurrences, set replace_all to true.\n` +
        `To replace only one occurrence, provide more context to uniquely identify the instance.\n` +
        `File: ${filePath}\nString: ${oldString}`
    }

    // ── 6. 保持引号风格（仅当通过 norm 匹配时要 apply） ─────────────
    const actualNewString = preserveQuoteStyle(oldString, actualOldString, newString)

    // ── 7. 尾随空白清理（非 Markdown） ─────────────────────────────────
    const isMarkdown = /\.(md|mdx)$/i.test(resolvedPath)
    const cleanedNewString = isMarkdown ? actualNewString : stripTrailingWhitespace(actualNewString)

    // ── 8. 执行替换 ────────────────────────────────────────────────────
    const updated = replaceAll
      ? currentContent.replaceAll(actualOldString, cleanedNewString)
      : currentContent.replace(actualOldString, cleanedNewString)

    if (updated === currentContent) {
      // 替换未生效（理论上不会走到这里，因为前面检查了 matchCount）
      return `Error: No changes made. old_string and new_string are the same?`
    }

    // ── 9. 写文件 ──────────────────────────────────────────────────────
    try {
      fs.writeFileSync(resolvedPath, updated, 'utf-8')
    } catch (err: any) {
      return `Error writing file: ${err.message ?? err}`
    }

    // ── 10. 更新缓存 ──────────────────────────────────────────────────
    try {
      fileStateCache.set(resolvedPath, {
        content: updated,
        timestamp: fs.statSync(resolvedPath).mtimeMs,
      })
    } catch {
      // 缓存更新失败不影响功能
    }

    // ── 10.5. LSP 文件同步 ────────────────────────────────────────────
    const lsp = getLSPManager()
    if (lsp) {
      lsp.changeFile(resolvedPath, updated).catch(() => {})
      lsp.saveFile(resolvedPath).catch(() => {})
    }

    // ── 11. 计算 diff 并返回结构化结果 ────────────────────────────────
    const diffData = computeDiff(filePath, currentContent, updated)
    const summary = `Edited ${filePath} (${diffData.additions} added, ${diffData.removals} removed)${replaceAll ? ' [replace all]' : ''}`
    return JSON.stringify({ summary, diff: diffData })
  }
}
