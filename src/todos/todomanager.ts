import { EventEmitter } from 'events'
import type { TodoItem, TodoItemStatus, TodoPlanSnapshot } from './todo.js'
import { attachmentQueue } from '../attachment/queue.js'
import {
  TaskStatusAttachment,
  TaskPlanCreatedAttachment,
  TaskPlanClearedAttachment,
} from '../attachment/task.js'

interface PlanState {
  planId: string
  description: string
  tasks: TodoItem[]
  createdAt: number
}

let nextId = 0
function genId(): string {
  return `plan-${++nextId}-${Date.now().toString(36)}`
}

/**
 * TodoManager — 单例，管理当前执行中的 todo plan。
 *
 * 行为：
 * - 同一时间只有一个活跃 plan（新 plan 会替换旧 plan）。
 * - 每次状态变更发出 'update' 事件，携带 TodoPlanSnapshot。
 * - 全部完成或任意失败时，isComplete = true，TUI 据此决定何时折叠。
 * - clear() 清空当前 plan 并发出 null snapshot。
 */
export class TodoManager extends EventEmitter {
  private current: PlanState | null = null

  /** 创建新 plan，替换当前。返回 snapshot。 */
  createPlan(description: string, taskDescriptions: string[]): TodoPlanSnapshot {
    const plan: PlanState = {
      planId: genId(),
      description,
      tasks: taskDescriptions.map(d => ({
        description: d,
        status: 'pending' as TodoItemStatus,
      })),
      createdAt: Date.now(),
    }
    this.current = plan
    const snapshot = this.toSnapshot(plan)
    this.emit('update', snapshot)
    attachmentQueue.enqueue(new TaskPlanCreatedAttachment(description, taskDescriptions.length))
    return snapshot
  }

  /** 更新指定索引任务的 status。返回最新 snapshot，无效索引返回 null。 */
  updateTask(index: number, status: TodoItemStatus, error?: string): TodoPlanSnapshot | null {
    if (!this.current) return null
    if (index < 0 || index >= this.current.tasks.length) return null
    this.current.tasks[index] = { ...this.current.tasks[index], status, error }
    const snapshot = this.toSnapshot(this.current)
    this.emit('update', snapshot)
    const desc = this.current.tasks[index].description
    attachmentQueue.enqueue(new TaskStatusAttachment(snapshot.planId, index, desc, status, error))
    return snapshot
  }

  /** 获取当前 plan snapshot，无 plan 时返回 null。 */
  getCurrentPlan(): TodoPlanSnapshot | null {
    if (!this.current) return null
    return this.toSnapshot(this.current)
  }

  /** 清空当前 plan（发出 null）。 */
  clear(): void {
    const planId = this.current?.planId
    this.current = null
    this.emit('update', null)
    if (planId) attachmentQueue.enqueue(new TaskPlanClearedAttachment(planId))
  }

  // ── private ──────────────────────────────────────────────────

  private toSnapshot(plan: PlanState): TodoPlanSnapshot {
    const done = plan.tasks.every(t => t.status === 'done')
    const failed = plan.tasks.some(t => t.status === 'failed')
    const completed = plan.tasks.filter(t => t.status === 'done' || t.status === 'failed').length
    return {
      planId: plan.planId,
      description: plan.description,
      tasks: [...plan.tasks],
      progress: `${completed}/${plan.tasks.length}`,
      allDone: done && !failed,
      hasFailure: failed,
      isComplete: done || failed,
    }
  }
}

// ── 全局单例 ─────────────────────────────────────────────────────
export const todoManager = new TodoManager()
