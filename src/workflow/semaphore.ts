// 信号量：控制并发 agent() 调用上限

import os from 'os'

export class Semaphore {
  private slots: number
  private readonly queue: Array<() => void> = []

  constructor(max: number) {
    this.slots = max
  }

  async acquire(): Promise<void> {
    if (this.slots > 0) {
      this.slots--
      return
    }
    await new Promise<void>(resolve => this.queue.push(resolve))
  }

  release(): void {
    if (this.queue.length > 0) {
      this.queue.shift()!()
    } else {
      this.slots++
    }
  }
}

/** 全局并发池：min(16, CPU核数 - 2)，最小 1 */
export function createGlobalPool(): Semaphore {
  const cpus = os.cpus().length
  const max = Math.max(1, Math.min(16, cpus - 2))
  return new Semaphore(max)
}
