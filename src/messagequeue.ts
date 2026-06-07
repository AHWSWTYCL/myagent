import { createSignal } from './state/signal.js'

/**
 * MessageQueue — 用户自然语言输入队列。
 *
 * 设计意图：
 * - 用户在 agent 正在处理时仍然可以通过 InputBox 输入后续 prompt
 * - 自然语言 prompt 入队，!/ 命令直接执行不入队
 * - runAgentLoopStream 在两个时间点 drain 队列：
 *   (1) 工具执行完成后
 *   (2) end_turn/stop 前（如有排队消息则不 break 而 continue）
 *
 * 消费方统一从队列中 dequeue，确保一次消费不重复。
 */
export type QueuePriority = 'now' | 'next' | 'later'

export type QueuedMessage =
  | { kind: 'user'; value: string; priority: QueuePriority }
  | { kind: 'mailbox-wake'; agentId: string; priority: QueuePriority }

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

export class MessageQueue {
  private queue: QueuedMessage[] = []
  private snapshot: readonly QueuedMessage[] = Object.freeze([])
  private changed = createSignal()

  subscribe(listener: () => void): () => void {
    return this.changed.subscribe(listener)
  }

  getSnapshot(): readonly QueuedMessage[] {
    return this.snapshot
  }

  /** 入队一条消息（自然语言 prompt） */
  enqueue(msg: string, priority: QueuePriority = 'next'): void {
    this.queue.push({ kind: 'user', value: msg, priority })
    this.notify()
  }

  enqueueMailboxWake(agentId: string): void {
    if (this.queue.some(item => item.kind === 'mailbox-wake' && item.agentId === agentId)) return
    this.queue.push({ kind: 'mailbox-wake', agentId, priority: 'later' })
    this.notify()
  }

  dequeueItem(): QueuedMessage | undefined {
    const idx = this.nextIndex()
    if (idx === -1) return undefined
    const [message] = this.queue.splice(idx, 1)
    this.notify()
    return message
  }

  /** 取出一条消息；队列空时返回 undefined */
  dequeue(): string | undefined {
    while (true) {
      const item = this.dequeueItem()
      if (!item) return undefined
      if (item.kind === 'user') return item.value
    }
  }

  /** 查看下一条消息但不移除 */
  peek(): string | undefined {
    const idx = this.nextIndex()
    const item = idx === -1 ? undefined : this.queue[idx]
    return item?.kind === 'user' ? item.value : undefined
  }

  /** 当前队列长度 */
  get length(): number {
    return this.queue.length
  }

  /** 清空队列 */
  clear(): void {
    if (this.queue.length === 0) return
    this.queue = []
    this.notify()
  }

  private nextIndex(): number {
    if (this.queue.length === 0) return -1

    let bestIdx = -1
    let bestPriority = Infinity
    for (let i = 0; i < this.queue.length; i++) {
      const priority = PRIORITY_ORDER[this.queue[i]!.priority]
      if (priority < bestPriority) {
        bestIdx = i
        bestPriority = priority
      }
    }
    return bestIdx
  }

  private notify(): void {
    this.snapshot = Object.freeze([...this.queue])
    this.changed.emit()
  }
}
