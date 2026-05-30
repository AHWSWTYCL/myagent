/**
 * AttachmentQueue — 系统状态变更的暂存队列，LLM 在 DRAIN POINT 消费。
 */
import { Attachment } from './attachment.js'

export class AttachmentQueue {
  private queue: Attachment[] = []

  enqueue(att: Attachment): void {
    this.queue.push(att)
  }

  drain(): Attachment[] {
    return this.queue.splice(0)
  }

  get length(): number {
    return this.queue.length
  }

  clear(): void {
    this.queue = []
  }

  formatDrain(): string {
    const items = this.drain()
    if (items.length === 0) return ''
    const lines = items.map(a => `  [${a.type}] ${a.content}`)
    return `[System State Changes]\n${lines.join('\n')}`
  }
}

export const attachmentQueue = new AttachmentQueue()
