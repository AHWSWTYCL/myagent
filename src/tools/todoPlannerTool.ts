import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { todoManager } from '../todos/todomanager.js'

interface TodoPlanArgs {
  description: string
  tasks: Array<{ description: string }>
}

/**
 * todo_plan — 一次性创建一组关联的待办任务。
 *
 * Agent（通常是 coordinator）用它来创建任务计划，而不是逐个调用 todo_create。
 * 所有任务初始状态为 pending。
 * 后续用 todo_update 更新单个任务状态。
 */
export class TodoPlannerTool extends Tool {
  get name(): string {
    return 'todo_plan'
  }

  get description(): string {
    return [
      'Create a group of related todo tasks in a single call.',
      'Use this when you want to present a task plan to the user with multiple sub-tasks.',
      'All tasks start as pending. Update individual task status with todo_update.',
      'The todo list is displayed in a fixed panel above the input box until all tasks complete or any fails.',
      'Example: todo_plan(description="Implement user login", tasks=[{description: "Explore auth code"}, {description: "Design login form"}, {description: "Implement API"}])',
    ].join(' ')
  }

  get inputSchemaZod() {
    return z.object({
      description: z.string().describe('Overall description of the task plan (e.g. "Implement user login")'),
      tasks: z.array(z.object({
        description: z.string().describe('Description of this sub-task'),
      })).describe('List of sub-tasks to complete'),
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
    const desc = ((input as unknown as TodoPlanArgs).description ?? '').split('\n')[0]
    return {
      label: '📋 Task Plan',
      args: desc.length > 60 ? desc.slice(0, 57) + '…' : desc,
    }
  }

  async execute(args: TodoPlanArgs): Promise<string> {
    if (!args.description || typeof args.description !== 'string') {
      return 'Error: description must be a non-empty string.'
    }
    if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
      return 'Error: tasks must be a non-empty array of {description: string}.'
    }
    for (const t of args.tasks) {
      if (!t.description || typeof t.description !== 'string') {
        return 'Error: each task must have a non-empty description string.'
      }
    }

    const snapshot = todoManager.createPlan(
      args.description,
      args.tasks.map(t => t.description),
    )

    return [
      `Plan "${snapshot.description}" created with ${snapshot.tasks.length} tasks.`,
      `Progress: ${snapshot.progress}`,
      ...snapshot.tasks.map((t, i) => `  ${i}. [${t.status}] ${t.description}`),
    ].join('\n')
  }
}
