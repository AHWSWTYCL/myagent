import { copyFile, mkdir, rm } from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import { tmpdir } from 'os'

/**
 * Copy-on-Write File Overlay — 参考 Claude Code 的 speculation overlay 机制。
 *
 * 设计意图：
 * - Write 工具（write_file/edit_file）写入 overlay 目录而非真实 cwd
 * - Read 工具优先读 overlay（如果文件已被写过），否则读 cwd
 * - accept 时 copy overlay → cwd
 * - reject/discard 时删除 overlay
 *
 * 这允许投机执行安全地使用写入工具，不会污染用户的工作目录。
 */
export class FileOverlay {
  readonly id: string
  readonly overlayPath: string
  readonly cwd: string
  /** overlay 中被修改过的文件（相对路径 → true） */
  readonly writtenPaths = new Set<string>()

  constructor(cwd: string) {
    this.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.overlayPath = join(tmpdir(), `myagent-spec-${this.id}`)
    this.cwd = cwd
  }

  /** 创建 overlay 目录 */
  async init(): Promise<boolean> {
    try {
      await mkdir(this.overlayPath, { recursive: true })
      return true
    } catch {
      return false
    }
  }

  /**
   * 重写文件工具输入中的路径：
   * - Write 工具：copy-on-write — 首次写入时先 copy 原文件到 overlay，然后路径指向 overlay
   * - Read 工具：如果文件已被写过，指向 overlay；否则保持原路径
   */
  async rewritePath(input: Record<string, unknown>, isWrite: boolean): Promise<Record<string, unknown>> {
    const pathKey = this.findPathKey(input)
    if (!pathKey) return input

    const filePath = input[pathKey] as string
    if (!filePath) return input

    const rel = this.resolveRelative(filePath)
    if (!rel) return input // 不能解析为相对路径，跳过

    if (isWrite) {
      // Copy-on-write: 首次写入时复制原文件
      if (!this.writtenPaths.has(rel)) {
        const overlayFile = join(this.overlayPath, rel)
        await mkdir(dirname(overlayFile), { recursive: true })
        try {
          await copyFile(join(this.cwd, rel), overlayFile)
        } catch {
          // 原文件可能不存在（新建文件场景），跳过
        }
        this.writtenPaths.add(rel)
      }
      return { ...input, [pathKey]: join(this.overlayPath, rel) }
    } else {
      // Read: 如果文件被写过，指向 overlay
      if (this.writtenPaths.has(rel)) {
        return { ...input, [pathKey]: join(this.overlayPath, rel) }
      }
      // 否则保持原路径（读 cwd）
      return input
    }
  }

  /**
   * Accept: 将所有 overlay 中的修改复制回 cwd
   */
  async accept(): Promise<void> {
    for (const rel of this.writtenPaths) {
      const src = join(this.overlayPath, rel)
      const dst = join(this.cwd, rel)
      try {
        await mkdir(dirname(dst), { recursive: true })
        await copyFile(src, dst)
      } catch (err) {
        process.stderr.write(`[speculative] overlay accept failed for ${rel}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
    await this.cleanup()
  }

  /** Discard: 删除 overlay，修改全部丢弃 */
  async discard(): Promise<void> {
    await this.cleanup()
  }

  private async cleanup(): Promise<void> {
    try {
      await rm(this.overlayPath, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }

  /** 解析为相对于 cwd 的路径；如果不是 cwd 下的文件，返回 null */
  private resolveRelative(filePath: string): string | null {
    try {
      const abs = isAbsolute(filePath) ? filePath : join(this.cwd, filePath)
      const rel = relative(this.cwd, abs)
      // 不在 cwd 下（如 ../outside）→ 拒绝
      if (rel.startsWith('..')) return null
      return rel
    } catch {
      return null
    }
  }

  /** 查找工具输入中的文件路径字段 */
  private findPathKey(input: Record<string, unknown>): string | null {
    // 常见的文件路径字段名
    const candidates = ['filePath', 'file_path', 'path', 'target_file']
    for (const key of candidates) {
      if (typeof input[key] === 'string') return key
    }
    return null
  }
}
