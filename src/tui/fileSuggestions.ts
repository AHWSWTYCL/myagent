import { readdir, stat as fsStat } from 'fs/promises'
import { resolve, dirname, basename, join, isAbsolute } from 'path'
import { homedir } from 'os'

export interface FileSuggestion {
  /** Display name (basename) */
  name: string
  /** Full @-prefixed path to insert on accept */
  atPath: string
  /** 'file' or 'directory' */
  kind: 'file' | 'directory'
}

/**
 * Extract the @path token the cursor is on.
 *
 * Scans backward from cursorOffset to find the @ that starts the current
 * whitespace-delimited token.
 *
 * Returns null if no valid @token found at cursor.
 */
export function extractAtToken(
  input: string,
  cursorOffset: number,
): { tokenStart: number; tokenEnd: number; pathPrefix: string } | null {
  const pos = Math.min(cursorOffset, input.length)
  if (pos === 0 && input[0] !== '@') return null

  // Find @ that starts the current token by scanning left
  let start = pos
  while (start > 0 && !/\s/.test(input[start - 1])) {
    start--
  }
  // Now start points to beginning of token. Must start with @
  if (input[start] !== '@') return null

  // Find end of the token (whitespace or end of string)
  let end = start + 1
  while (end < input.length && !/\s/.test(input[end])) {
    end++
  }

  if (start >= end) return null

  // pathPrefix is everything after @ to end of token
  const pathPrefix = input.slice(start + 1, end)

  return { tokenStart: start, tokenEnd: end, pathPrefix }
}

/**
 * Resolve a path prefix into a search directory + filename prefix.
 */
export async function resolvePathPrefix(
  rawPrefix: string,
  cwd: string,
): Promise<{ searchDir: string; filePrefix: string } | null> {
  let expanded = rawPrefix
  if (expanded.startsWith('~/') || expanded === '~') {
    expanded = expanded.replace('~', homedir())
  }

  let searchDir: string
  let filePrefix: string

  if (expanded === '' || expanded === '.' || expanded === './') {
    searchDir = cwd
    filePrefix = ''
  } else if (isAbsolute(expanded)) {
    try {
      const s = await fsStat(expanded)
      if (s.isDirectory()) {
        searchDir = expanded
        filePrefix = ''
      } else {
        searchDir = dirname(expanded)
        filePrefix = basename(expanded)
      }
    } catch {
      const parent = dirname(expanded)
      if (parent === expanded) {
        searchDir = expanded
        filePrefix = ''
      } else {
        searchDir = parent
        filePrefix = basename(expanded)
      }
    }
  } else {
    const full = resolve(cwd, expanded)
    try {
      const s = await fsStat(full)
      if (s.isDirectory()) {
        searchDir = full
        filePrefix = ''
      } else {
        searchDir = dirname(full)
        filePrefix = basename(full)
      }
    } catch {
      const parent = dirname(full)
      if (parent === full) {
        searchDir = full
        filePrefix = ''
      } else {
        searchDir = parent
        filePrefix = basename(full)
      }
    }
  }

  try {
    const s = await fsStat(searchDir)
    if (!s.isDirectory()) return null
  } catch {
    return null
  }

  return { searchDir, filePrefix }
}

/**
 * Get file/directory suggestions for a path prefix.
 * Directories come first, then files.
 */
export async function getFileSuggestions(
  rawPrefix: string,
  cwd: string,
): Promise<FileSuggestion[]> {
  const resolved = await resolvePathPrefix(rawPrefix, cwd)
  if (!resolved) return []

  const { searchDir, filePrefix } = resolved

  let entries: string[]
  try {
    entries = await readdir(searchDir)
  } catch {
    return []
  }

  const lowerPrefix = filePrefix.toLowerCase()
  const matched = entries
    .filter(name => name.toLowerCase().startsWith(lowerPrefix))
    .filter(name => lowerPrefix.startsWith('.') || !name.startsWith('.'))
    .filter(name => name !== 'node_modules')

  const dirs: string[] = []
  const files: string[] = []

  for (const name of matched) {
    try {
      const s = await fsStat(join(searchDir, name))
      if (s.isDirectory()) dirs.push(name)
      else if (s.isFile()) files.push(name)
    } catch { /* skip */ }
  }

  dirs.sort((a, b) => a.localeCompare(b))
  files.sort((a, b) => a.localeCompare(b))

  const MAX = 50
  const results: FileSuggestion[] = []

  // parentPath = 目录部分（相对于 cwd），以 / 结尾；cwd 则为 ''
  // 计算规则：
  //   1. filePrefix 非空 + 无斜杠 → 纯文件名前缀，parentPath = ''
  //   2. filePrefix 非空 + 有斜杠 → 取最后一个 / 之前的部分
  //   3. filePrefix 为空 → rawPrefix 本身就是目录名，加 /
  const hasSlash = rawPrefix.includes('/')
  const parentPath = rawPrefix === '' || rawPrefix.endsWith('/')
    ? rawPrefix
    : filePrefix === ''
      ? rawPrefix + '/'
      : hasSlash
        ? rawPrefix.slice(0, rawPrefix.lastIndexOf('/') + 1)
        : ''

  for (const dir of dirs.slice(0, MAX)) {
    results.push({ name: dir, atPath: '@' + parentPath + dir, kind: 'directory' })
  }
  for (const file of files.slice(0, MAX - results.length)) {
    results.push({ name: file, atPath: '@' + parentPath + file, kind: 'file' })
  }

  return results
}

/**
 * Replace the @token in input with the completed path.
 */
export function applyFileCompletion(
  input: string,
  tokenStart: number,
  tokenEnd: number,
  completedAtPath: string,
): string {
  return input.slice(0, tokenStart) + completedAtPath + input.slice(tokenEnd)
}
