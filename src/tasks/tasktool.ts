/**
 * TaskTool — 供 LLM 调用的任务管理工具
 *
 * LLM 可以通过此工具创建、查看、列出、更新、删除任务，
 * 以及查看任务的依赖关系图。
 */

import { z } from 'zod'
import { Tool, type ToolRenderHeader } from '../tools/tool.js'
import { TaskManager, formatTaskDetail, formatTaskLine } from './taskmanager.js'
import { TaskStatus, TASK_STATUSES, STATUS_ICON } from './task.js'

type TaskAction = 'create' | 'get' | 'list' | 'update' | 'delete' | 'graph'

export class TaskTool extends Tool {
  private manager = new TaskManager()

  /** 最后一次 list 操作的结构化结果，供 TUI 通过 ToolRenderContext 读取 */
  lastListPayload: Array<{
    id: string
    title: string
    status: TaskStatus
    depends_on: string[]
  }> | null = null

  get name(): string {
    return 'task'
  }

  get description(): string {
    return (
      '管理基于文档的任务系统。支持创建、查看、列出、更新、删除任务，以及查看依赖关系图。' +
      '每个任务有 id、状态(todo/in_progress/done/blocked/cancelled)、依赖关系、subagent_id 等字段。' +
      '当一个任务标记为 done 时，依赖它的任务会自动被解锁（blocked → todo）。'
    )
  }

  get inputSchemaZod() {
    return z.object({
      action: z.enum(['create', 'get', 'list', 'update', 'delete', 'graph'])
        .describe('create: 创建任务 | get: 查看任务详情 | list: 列出任务 | update: 更新任务 | delete: 删除任务 | graph: 查看依赖图'),
      id: z.string().optional().describe('任务 ID（get/update/delete/graph 时必填）'),
      title: z.string().optional().describe('任务标题（create 时必填）'),
      description: z.string().optional().describe('任务详细描述'),
      status: z.enum(['todo', 'in_progress', 'done', 'blocked', 'cancelled']).optional()
        .describe('任务状态（update 时可选）'),
      subagent_id: z.string().optional().describe('执行此任务的 sub-agent ID（update 时可选）'),
      depends_on: z.array(z.string()).optional()
        .describe('前置依赖的任务 ID 列表，如 ["task-abc1", "task-abc2"]'),
      filter_status: z.enum(['todo', 'in_progress', 'done', 'blocked', 'cancelled']).optional()
        .describe('list 时按状态过滤'),
    })
  }

  get outputSchemaZod() {
    return z.string()
  }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const action = String(input.action ?? '')
    if (action === 'list') {
      return { label: 'TaskList', args: '' }
    }
    const id = String(input.id ?? input.title ?? '')
    return { label: 'Task', args: id ? `${action} ${id}` : action }
  }

  async execute(args: Record<string, any>): Promise<string> {
    const action = args.action as TaskAction

    try {
      switch (action) {
        case 'create':
          return this.handleCreate(args)
        case 'get':
          return this.handleGet(args)
        case 'list':
          return this.handleList(args)
        case 'update':
          return this.handleUpdate(args)
        case 'delete':
          return this.handleDelete(args)
        case 'graph':
          return this.handleGraph(args)
        default:
          return `未知操作: ${action}，支持的操作: create, get, list, update, delete, graph`
      }
    } catch (err: any) {
      return `❌ 错误: ${err.message}`
    }
  }

  private handleCreate(args: Record<string, any>): string {
    if (!args.title) return '❌ 创建任务需要提供 title'

    const dependsOn: string[] | undefined = Array.isArray(args.depends_on)
      ? args.depends_on
      : undefined

    const task = this.manager.create({
      title: args.title,
      description: args.description ?? '',
      depends_on: dependsOn,
      subagent_id: args.subagent_id ?? '',
    })

    const depInfo = task.depends_on.length > 0 ? `\n  依赖: ${task.depends_on.join(', ')}` : ''
    return (
      `✅ 任务已创建\n` +
      `  ID: ${task.id}\n` +
      `  状态: ${STATUS_ICON[task.status]} ${task.status}\n` +
      `  标题: ${task.title}${depInfo}`
    )
  }

  private handleGet(args: Record<string, any>): string {
    if (!args.id) return '❌ 查看任务需要提供 id'

    const task = this.manager.get(args.id)
    if (!task) return `❌ 任务 ${args.id} 不存在`

    return formatTaskDetail(task)
  }

  private handleList(args: Record<string, any>): string {
    const filter = args.filter_status
      ? { status: args.filter_status as TaskStatus }
      : undefined

    const tasks = this.manager.list(filter)

    if (tasks.length === 0) {
      return filter
        ? `📭 没有找到状态为 "${filter.status}" 的任务`
        : '📭 当前没有任何任务'
    }

    const lines: string[] = [
      `📋 任务列表（共 ${tasks.length} 个）${filter ? `，过滤状态: ${filter.status}` : ''}`,
      '',
    ]

    for (const task of tasks) {
      lines.push(formatTaskLine(task))
    }

    // 将结构化数据存到实例属性，供 TUI 通过 ToolRenderContext 读取。
    // 不再拼入返回文本，避免原始 JSON 污染 LLM 上下文（浪费 token）。
    this.lastListPayload = tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      depends_on: t.depends_on,
    }))

    return lines.join('\n')
  }

  private handleUpdate(args: Record<string, any>): string {
    if (!args.id) return '❌ 更新任务需要提供 id'

    const updateData: Record<string, any> = {}

    if (args.status) updateData.status = args.status
    if (args.subagent_id !== undefined) updateData.subagent_id = args.subagent_id
    if (args.title !== undefined) updateData.title = args.title
    if (args.description !== undefined) updateData.description = args.description
    if (args.depends_on !== undefined) {
      updateData.depends_on = Array.isArray(args.depends_on)
        ? args.depends_on
        : String(args.depends_on).split(',').map((s: string) => s.trim()).filter(Boolean)
    }

    if (Object.keys(updateData).length === 0) {
      return '❌ 未提供要更新的字段（status / subagent_id / title / description / depends_on）'
    }

    const task = this.manager.update(args.id, updateData as any)
    if (!task) return `❌ 任务 ${args.id} 不存在`

    const changes = Object.keys(updateData).join(', ')
    return (
      `✅ 任务 ${args.id} 已更新（${changes}）\n` +
      `  当前状态: ${STATUS_ICON[task.status]} ${task.status}`
    )
  }

  private handleDelete(args: Record<string, any>): string {
    if (!args.id) return '❌ 删除任务需要提供 id'

    const deleted = this.manager.delete(args.id)
    if (!deleted) return `❌ 任务 ${args.id} 不存在`
    return `🗑️ 任务 ${args.id} 已删除`
  }

  private handleGraph(args: Record<string, any>): string {
    if (!args.id) return '❌ 查看依赖图需要提供 id'

    const { task, dependents, dependencies } = this.manager.graph(args.id)
    if (!task) return `❌ 任务 ${args.id} 不存在`

    const lines: string[] = [
      `🔗 依赖图: ${task.id} — ${task.title} (${STATUS_ICON[task.status]} ${task.status})`,
      '',
    ]

    if (dependencies.length > 0) {
      lines.push('  ◀ 前置依赖（我依赖谁）:')
      for (const dep of dependencies) {
        lines.push(`    ${STATUS_ICON[dep.status]} ${dep.id} — ${dep.title}`)
      }
    } else {
      lines.push('  ◀ 前置依赖: (无)')
    }

    lines.push('')

    if (dependents.length > 0) {
      lines.push('  ▶ 后置依赖（谁依赖我）:')
      for (const dep of dependents) {
        lines.push(`    ${STATUS_ICON[dep.status]} ${dep.id} — ${dep.title}`)
      }
    } else {
      lines.push('  ▶ 后置依赖: (无)')
    }

    return lines.join('\n')
  }
}
