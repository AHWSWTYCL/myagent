/**
 * FileStateCache — 文件读取状态追踪。
 *
 * 设计意图：
 * - 维护"文件是否已被读取"的状态，供 EditTool 读前检查
 * - 记录读取时的时间戳和内容，供 EditTool 做文件过时检测
 * - LRU 约束防止内存膨胀
 */
import path from 'path'

export interface FileState {
  content: string
  /** 文件的 mtime（ms），用于检测外部修改 */
  timestamp: number
  /** 是否为局部/注入视图。为 true 时 EditTool 也会拒绝 */
  isPartialView?: boolean
}

const DEFAULT_MAX = 100

const entries = new Map<string, FileState>()
let maxEntries = DEFAULT_MAX

/**
 * 设置最大缓存条目数（超出时淘汰最旧的）
 */
export function setFileStateCacheMax(n: number): void {
  maxEntries = n
}

function normalizeKey(key: string): string {
  return path.resolve(key)
}

function evictIfNeeded(): void {
  while (entries.size >= maxEntries) {
    const oldest = entries.keys().next()
    if (oldest.done) break
    entries.delete(oldest.value)
  }
}

export const fileStateCache = {
  get(key: string): FileState | undefined {
    return entries.get(normalizeKey(key))
  },

  set(key: string, value: FileState): void {
    const nk = normalizeKey(key)
    entries.set(nk, value)
    evictIfNeeded()
  },

  has(key: string): boolean {
    return entries.has(normalizeKey(key))
  },

  delete(key: string): boolean {
    return entries.delete(normalizeKey(key))
  },

  clear(): void {
    entries.clear()
  },

  get size(): number {
    return entries.size
  },
}
