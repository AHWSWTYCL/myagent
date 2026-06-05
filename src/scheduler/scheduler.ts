import { SchedulerManager } from './schedulermanager.js'
import type { TuiBridge } from '../tui/bridge.js'

const CHECK_INTERVAL_MS = 30_000  // poll every 30 seconds
const INITIAL_DELAY_MS = 10_000   // first check after 10s (catch tasks missed while offline)

export class Scheduler {
  private manager = new SchedulerManager()
  private timer: ReturnType<typeof setInterval> | null = null
  private initialTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly runTurn: (prompt: string) => Promise<void | { backgrounded?: boolean }>,
    private readonly isRunning: () => boolean,
    private readonly bridge: TuiBridge,
  ) {}

  start(): void {
    this.initialTimer = setTimeout(() => {
      this.tick()
      this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS)
    }, INITIAL_DELAY_MS)
  }

  stop(): void {
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null }
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async tick(): Promise<void> {
    if (this.isRunning()) return

    const due = this.manager.getDue()
    if (due.length === 0) return

    for (const task of due) {
      if (this.isRunning()) break

      this.manager.markRunning(task.id)
      const typeLabel = task.type === 'cron' ? `[cron: ${task.cron}]` : '[once]'
      this.bridge.emitMessage('system', `⏰ 定时任务触发 ${typeLabel} ${task.id}: ${task.prompt}`)

      try {
        await this.runTurn(task.prompt)
        this.manager.markDone(task.id)
      } catch (err: any) {
        const errMsg = err?.message ?? String(err)
        this.manager.markFailed(task.id, errMsg)
        this.bridge.emitMessage('system', `❌ 定时任务 ${task.id} 执行失败: ${errMsg}`)
      }
    }
  }
}
