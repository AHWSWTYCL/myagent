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
export class MessageQueue {
  private queue: string[] = []

  /** 入队一条消息（自然语言 prompt） */
  enqueue(msg: string): void {
    this.queue.push(msg)
  }

  /** 取出一条消息；队列空时返回 undefined */
  dequeue(): string | undefined {
    return this.queue.shift()
  }

  /** 查看下一条消息但不移除 */
  peek(): string | undefined {
    return this.queue[0]
  }

  /** 当前队列长度 */
  get length(): number {
    return this.queue.length
  }

  /** 清空队列 */
  clear(): void {
    this.queue = []
  }
}
