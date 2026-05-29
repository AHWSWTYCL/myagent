/**
 * Todo V2 — 轻量待办清单系统。
 *
 * 与 kanban 任务系统（src/tasks/）不同，todo 是 agent 在当前用户输入轮次内
 * 创建的临时待办列表，用于追踪子任务进度。内存驻留，不持久化。
 */

/** 单个待办任务的状态 */
export type TodoItemStatus = 'pending' | 'in_progress' | 'done' | 'failed'

/** 单个待办任务 */
export interface TodoItem {
  description: string
  status: TodoItemStatus
  error?: string
}

/** 一次 todo plan 的完整快照（桥接到 TUI） */
export interface TodoPlanSnapshot {
  planId: string
  description: string
  tasks: TodoItem[]
  progress: string       // "2/5"
  allDone: boolean       // 全部完成（无失败）
  hasFailure: boolean    // 是否有任务失败
  isComplete: boolean    // allDone || hasFailure
}

// ── 渲染常量 ─────────────────────────────────────────────────────

export const TODO_STATUS_ICON: Record<TodoItemStatus, string> = {
  pending: '⏳',
  in_progress: '🔄',
  done: '✅',
  failed: '❌',
}

export const PROGRESS_BAR_WIDTH = 12
