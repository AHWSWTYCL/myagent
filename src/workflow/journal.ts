// Journal：workflow 恢复机制，基于 (prompt, opts) 哈希缓存 agent() 结果

import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

export interface JournalEntry {
  key: string
  result: unknown
  timestamp: number
}

export class Journal {
  private readonly entries = new Map<string, unknown>()
  private readonly filePath: string

  constructor(runId: string, journalDir?: string) {
    const dir = journalDir ?? path.join(os.homedir(), '.myagent', 'workflow-journals')
    fs.mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, `${runId}.jsonl`)
  }

  /** 从磁盘加载已有 journal（用于 resume） */
  load(): void {
    if (!fs.existsSync(this.filePath)) return
    const lines = fs.readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry: JournalEntry = JSON.parse(line)
        this.entries.set(entry.key, entry.result)
      } catch {
        // 跳过损坏行
      }
    }
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get(key: string): unknown {
    return this.entries.get(key)
  }

  /** 写入新条目到内存和磁盘 */
  set(key: string, result: unknown): void {
    this.entries.set(key, result)
    const entry: JournalEntry = { key, result, timestamp: Date.now() }
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8')
  }

  get size(): number {
    return this.entries.size
  }
}

/** 生成 agent() 调用的缓存 key：sha256(prompt + JSON.stringify(opts)) */
export function agentKey(prompt: string, opts?: unknown): string {
  const raw = prompt + '\x00' + JSON.stringify(opts ?? null)
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}
