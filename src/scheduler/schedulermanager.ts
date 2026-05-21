import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import cronParser from 'cron-parser'
const { parseExpression } = cronParser
import { ScheduledTask, ScheduledTaskStatus, ScheduledTaskType } from './scheduledtask.js'

const SCHEDULED_DIR = path.join(os.homedir(), '.myagent', 'scheduled')

function computeNextRunAt(cronExpr: string): string {
  const interval = parseExpression(cronExpr)
  return interval.next().toISOString()
}

type CreateOnce = { type: 'once'; prompt: string; run_at: string; auto_delete?: boolean }
type CreateCron = { type: 'cron'; prompt: string; cron: string }
type CreateData = CreateOnce | CreateCron

export class SchedulerManager {
  constructor() {
    fs.mkdirSync(SCHEDULED_DIR, { recursive: true })
  }

  private taskPath(id: string): string {
    return path.join(SCHEDULED_DIR, `${id}.json`)
  }

  private generateId(type: ScheduledTaskType): string {
    const prefix = type === 'cron' ? 'cron' : 'once'
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
  }

  private write(task: ScheduledTask): void {
    fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2), 'utf-8')
  }

  create(data: CreateData): ScheduledTask {
    const id = this.generateId(data.type)
    const now = new Date().toISOString()

    const base = {
      id,
      type: data.type,
      prompt: data.prompt,
      status: 'pending' as const,
      run_count: 0,
      auto_delete: false,
      created_at: now,
      updated_at: now,
    }

    let task: ScheduledTask
    if (data.type === 'once') {
      task = { ...base, run_at: data.run_at, auto_delete: data.auto_delete ?? true }
    } else {
      task = { ...base, cron: data.cron, next_run_at: computeNextRunAt(data.cron) }
    }

    this.write(task)
    return task
  }

  get(id: string): ScheduledTask | null {
    const p = this.taskPath(id)
    if (!fs.existsSync(p)) return null
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    } catch {
      return null
    }
  }

  list(filter?: { status?: ScheduledTaskStatus; type?: ScheduledTaskType }): ScheduledTask[] {
    const files = fs.readdirSync(SCHEDULED_DIR).filter(f => f.endsWith('.json'))
    let tasks: ScheduledTask[] = []
    for (const f of files) {
      try {
        tasks.push(JSON.parse(fs.readFileSync(path.join(SCHEDULED_DIR, f), 'utf-8')))
      } catch {
        // skip corrupt files
      }
    }
    if (filter?.status) tasks = tasks.filter(t => t.status === filter.status)
    if (filter?.type) tasks = tasks.filter(t => t.type === filter.type)

    // Sort by next fire time
    return tasks.sort((a, b) => {
      const ta = a.type === 'once' ? (a.run_at ?? '') : (a.next_run_at ?? '')
      const tb = b.type === 'once' ? (b.run_at ?? '') : (b.next_run_at ?? '')
      return ta.localeCompare(tb)
    })
  }

  /** Returns all pending tasks that are due now or overdue. */
  getDue(): ScheduledTask[] {
    const now = new Date()
    return this.list({ status: 'pending' }).filter(t => {
      const fireAt = t.type === 'once' ? t.run_at : t.next_run_at
      return fireAt != null && new Date(fireAt) <= now
    })
  }

  /** Mark a task as currently running. */
  markRunning(id: string): void {
    const task = this.get(id)
    if (!task) return
    task.status = 'running'
    task.updated_at = new Date().toISOString()
    this.write(task)
  }

  /**
   * Called after a task completes successfully.
   * - once + auto_delete: delete the file
   * - once + keep:        mark done
   * - cron:               compute next_run_at, reset to pending, increment run_count
   */
  markDone(id: string): void {
    const task = this.get(id)
    if (!task) return
    const now = new Date().toISOString()

    if (task.type === 'once') {
      if (task.auto_delete) {
        fs.unlinkSync(this.taskPath(id))
      } else {
        task.status = 'done'
        task.run_count++
        task.last_run_at = now
        task.updated_at = now
        this.write(task)
      }
    } else {
      // cron: schedule next run
      task.run_count++
      task.last_run_at = now
      task.next_run_at = computeNextRunAt(task.cron!)
      task.status = 'pending'
      task.result = undefined
      task.updated_at = now
      this.write(task)
    }
  }

  /**
   * Called after a task fails.
   * - once: mark failed (terminal)
   * - cron: record error but schedule next run (cron jobs survive failures)
   */
  markFailed(id: string, error: string): void {
    const task = this.get(id)
    if (!task) return
    const now = new Date().toISOString()

    if (task.type === 'once') {
      task.status = 'failed'
      task.result = error
      task.updated_at = now
      this.write(task)
    } else {
      task.run_count++
      task.last_run_at = now
      task.next_run_at = computeNextRunAt(task.cron!)
      task.status = 'pending'
      task.result = `[last error] ${error}`
      task.updated_at = now
      this.write(task)
    }
  }

  cancel(id: string): boolean {
    const task = this.get(id)
    if (!task || task.status !== 'pending') return false
    task.status = 'cancelled'
    task.updated_at = new Date().toISOString()
    this.write(task)
    return true
  }
}

/** Validate a cron expression. Returns an error message or null if valid. */
export function validateCron(expr: string): string | null {
  try {
    parseExpression(expr)
    return null
  } catch (e: any) {
    return e.message ?? 'invalid cron expression'
  }
}
