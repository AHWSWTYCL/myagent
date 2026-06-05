import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { todoManager } from '../todos/todomanager.js'
import type { TodoItemStatus } from '../todos/todo.js'

interface TodoUpdateArgs {
  taskIndex: number
  status: 'pending' | 'in_progress' | 'done' | 'failed'
  error?: string
}

/**
 * todo_update — 更新 todo plan 中某个子任务的状态。
 *
 * Agent（通常是 coordinator）用它来实时更新每个子任务的进度。
 * TUI 会通过 bridge 事件实时刷新 TodoPanel。
 */
export class TodoUpdateTool extends Tool {
  get name(): string {
    return 'todo_update'
  }

  get description(): string {
    return [
      'Update the status of a single task in the current todo plan.',
      'Valid statuses: pending, in_progress, done, failed.',
      'When a task fails, provide an error message to explain why.',
      'The todo panel refreshes in real-time above the input box.',
    ].join(' ')
  }

  get inputSchemaZod() {
    return z.object({
      taskIndex: z.number().int().nonnegative().describe('Zero-based index of the task to update (first task = 0)'),
      status: z.enum(['pending', 'in_progress', 'done', 'failed']).describe('New status for the task'),
      error: z.string().optional().describe('Error message (required when status=failed)'),
    })
  }

  get outputSchemaZod() {
    return z.string()
  }

  get parallelSafe(): boolean {
    return false
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const args = input as unknown as TodoUpdateArgs
    const current = todoManager.getCurrentPlan()
    const taskDesc = current?.tasks[args.taskIndex]?.description ?? `task #${args.taskIndex}`
    return {
      label: '📋 Update',
      args: `${args.status} ${taskDesc.length > 40 ? taskDesc.slice(0, 37) + '…' : taskDesc}`,
    }
  }

  async execute(args: TodoUpdateArgs): Promise<string> {
    const { taskIndex, status, error } = args

    if (typeof taskIndex !== 'number' || taskIndex < 0) {
      return 'Error: taskIndex must be a non-negative number.'
    }

    const validStatuses: TodoItemStatus[] = ['pending', 'in_progress', 'done', 'failed']
    if (!validStatuses.includes(status)) {
      return `Error: invalid status "${status}". Valid values: ${validStatuses.join(', ')}`
    }

    if (status === 'failed' && !error) {
      return 'Error: error message is required when status=failed.'
    }

    const snapshot = todoManager.updateTask(taskIndex, status, error)
    if (!snapshot) {
      return 'Error: no active todo plan. Create one first with todo_plan.'
    }

    const task = snapshot.tasks[taskIndex]
    const lines = [
      `Updated task #${taskIndex} → [${task.status}] ${task.description}`,
    ]
    if (task.error) {
      lines.push(`  Error: ${task.error}`)
    }
    lines.push(`  Progress: ${snapshot.progress}`)

    if (snapshot.allDone) {
      lines.push('✅ All tasks completed!')
    } else if (snapshot.hasFailure) {
      lines.push('⚠ One or more tasks failed. Review and decide next steps.')
    }

    return lines.join('\n')
  }
}
