/**
 * 任务系统的类型定义
 */

/** 任务状态 */
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled'

/** 所有合法状态 */
export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'blocked', 'cancelled']

/** 状态对应的显示图标 */
export const STATUS_ICON: Record<TaskStatus, string> = {
  todo: '📋',
  in_progress: '🔄',
  done: '✅',
  blocked: '⏸️',
  cancelled: '🗑️',
}

/** list 排序优先级（数字越小越靠前） */
export const STATUS_ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  todo: 1,
  blocked: 2,
  cancelled: 3,
  done: 4,
}

/** 任务数据结构 */
export interface Task {
  id: string
  status: TaskStatus
  subagent_id: string
  depends_on: string[]
  depended_by: string[]
  title: string
  description: string
  created_at: string
  updated_at: string
}
