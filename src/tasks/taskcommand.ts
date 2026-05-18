/**
 * TaskCommand — 命令行 /task 命令
 *
 * 用法：
 *   /task create <title> [--desc "描述"] [--depends id1,id2]
 *   /task list [status]
 *   /task show <id>
 *   /task update <id> --status done [--subagent-id xxx] [--title xxx] [--desc xxx]
 *   /task delete <id>
 *   /task graph <id>
 */

import { Command } from '../commands/command.js'
import { TaskManager, formatTaskDetail, formatTaskLine } from './taskmanager.js'
import { TaskStatus, TASK_STATUSES, STATUS_ICON } from './task.js'

export class TaskCommand extends Command {
  private manager = new TaskManager()

  get name(): string {
    return 'task'
  }

  get description(): string {
    return '管理基于文档的任务系统'
  }

  get usage(): string {
    return [
      '  /task create <title> [--desc "描述"] [--depends id1,id2]   创建任务',
      '  /task list [status]                                        列出任务',
      '  /task show <id>                                            查看任务详情',
      '  /task update <id> --status <s> [--subagent-id <id>] ...    更新任务',
      '  /task delete <id>                                          删除任务',
      '  /task graph <id>                                           查看依赖图',
    ].join('\n')
  }

  async execute(args: string[]): Promise<void> {
    const subcommand = args[0]

    switch (subcommand) {
      case 'create':
        await this.handleCreate(args.slice(1))
        break
      case 'list':
        await this.handleList(args.slice(1))
        break
      case 'show':
        await this.handleShow(args.slice(1))
        break
      case 'update':
        await this.handleUpdate(args.slice(1))
        break
      case 'delete':
        await this.handleDelete(args.slice(1))
        break
      case 'graph':
        await this.handleGraph(args.slice(1))
        break
      default:
        console.log(`未知子命令: ${subcommand}`)
        console.log(`用法:\n${this.usage}`)
    }
  }

  private parseOptions(args: string[]): { positional: string[]; options: Record<string, string> } {
    const positional: string[] = []
    const options: Record<string, string> = {}

    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) {
        const key = args[i].slice(2)
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          options[key] = args[i + 1]
          i++
        } else {
          options[key] = 'true'
        }
      } else {
        positional.push(args[i])
      }
    }

    return { positional, options }
  }

  private async handleCreate(args: string[]): Promise<void> {
    const { positional, options } = this.parseOptions(args)

    if (positional.length === 0) {
      console.log('❌ 用法: /task create <title> [--desc "描述"] [--depends id1,id2]')
      return
    }

    const title = positional.join(' ')
    const description = options.desc ?? ''
    const dependsOn = options.depends
      ? options.depends.split(',').map(s => s.trim()).filter(Boolean)
      : undefined

    try {
      const task = this.manager.create({ title, description, depends_on: dependsOn })
      const depInfo = task.depends_on.length > 0 ? `\n  依赖: ${task.depends_on.join(', ')}` : ''
      console.log(
        `✅ 任务已创建\n` +
        `  ID: ${task.id}\n` +
        `  状态: ${STATUS_ICON[task.status]} ${task.status}\n` +
        `  标题: ${task.title}${depInfo}`,
      )
    } catch (err: any) {
      console.log(`❌ 错误: ${err.message}`)
    }
  }

  private async handleList(args: string[]): Promise<void> {
    const statusFilter = args[0] as TaskStatus | undefined

    if (statusFilter && !TASK_STATUSES.includes(statusFilter)) {
      console.log(`❌ 非法状态: ${statusFilter}，可选值: ${TASK_STATUSES.join(', ')}`)
      return
    }

    const tasks = this.manager.list(statusFilter ? { status: statusFilter } : undefined)

    if (tasks.length === 0) {
      console.log(
        statusFilter
          ? `📭 没有状态为 "${statusFilter}" 的任务`
          : '📭 当前没有任何任务',
      )
      return
    }

    console.log(`📋 任务列表（共 ${tasks.length} 个）${statusFilter ? `，状态: ${statusFilter}` : ''}`)
    console.log('')

    for (const task of tasks) {
      console.log(formatTaskLine(task))
    }
  }

  private async handleShow(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) {
      console.log('❌ 用法: /task show <id>')
      return
    }

    const task = this.manager.get(id)
    if (!task) {
      console.log(`❌ 任务 ${id} 不存在`)
      return
    }

    console.log(formatTaskDetail(task))
  }

  private async handleUpdate(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) {
      console.log('❌ 用法: /task update <id> --status <s> [--subagent-id <id>] [--title <t>] [--desc <d>]')
      return
    }

    const { options } = this.parseOptions(args.slice(1))
    const updateData: Record<string, any> = {}

    if (options.status) {
      if (!TASK_STATUSES.includes(options.status as TaskStatus)) {
        console.log(`❌ 非法状态: ${options.status}`)
        return
      }
      updateData.status = options.status
    }
    if (options['subagent-id']) updateData.subagent_id = options['subagent-id']
    if (options.title) updateData.title = options.title
    if (options.desc) updateData.description = options.desc
    if (options.depends) {
      updateData.depends_on = options.depends.split(',').map((s: string) => s.trim()).filter(Boolean)
    }

    if (Object.keys(updateData).length === 0) {
      console.log('❌ 未提供要更新的字段')
      return
    }

    try {
      const task = this.manager.update(id, updateData as any)
      if (!task) {
        console.log(`❌ 任务 ${id} 不存在`)
        return
      }
      console.log(`✅ 任务 ${id} 已更新`)
      console.log(`  当前状态: ${STATUS_ICON[task.status]} ${task.status}`)
    } catch (err: any) {
      console.log(`❌ 错误: ${err.message}`)
    }
  }

  private async handleDelete(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) {
      console.log('❌ 用法: /task delete <id>')
      return
    }

    const deleted = this.manager.delete(id)
    if (!deleted) {
      console.log(`❌ 任务 ${id} 不存在`)
      return
    }
    console.log(`🗑️ 任务 ${id} 已删除`)
  }

  private async handleGraph(args: string[]): Promise<void> {
    const id = args[0]
    if (!id) {
      console.log('❌ 用法: /task graph <id>')
      return
    }

    const { task, dependents, dependencies } = this.manager.graph(id)
    if (!task) {
      console.log(`❌ 任务 ${id} 不存在`)
      return
    }

    console.log(`🔗 依赖图: ${task.id} — ${task.title} (${STATUS_ICON[task.status]} ${task.status})`)
    console.log('')

    if (dependencies.length > 0) {
      console.log('  ◀ 前置依赖（我依赖谁）:')
      for (const dep of dependencies) {
        console.log(`    ${STATUS_ICON[dep.status]} ${dep.id} — ${dep.title}`)
      }
    } else {
      console.log('  ◀ 前置依赖: (无)')
    }

    console.log('')

    if (dependents.length > 0) {
      console.log('  ▶ 后置依赖（谁依赖我）:')
      for (const dep of dependents) {
        console.log(`    ${STATUS_ICON[dep.status]} ${dep.id} — ${dep.title}`)
      }
    } else {
      console.log('  ▶ 后置依赖: (无)')
    }
  }
}
