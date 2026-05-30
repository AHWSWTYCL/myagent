import { z } from 'zod'
import { Tool, type ToolRenderHeader } from '../tools/tool.js'
import { SchedulerManager, validateCron } from './schedulermanager.js'
import { ScheduledTask, ScheduledTaskStatus, ScheduledTaskType } from './scheduledtask.js'

function formatTask(t: ScheduledTask): string {
  const fireTime = t.type === 'once'
    ? new Date(t.run_at!).toLocaleString('zh-CN')
    : `${t.cron}  (下次: ${new Date(t.next_run_at!).toLocaleString('zh-CN')})`
  const runInfo = t.run_count > 0 ? `  已执行 ${t.run_count} 次` : ''
  const errInfo = t.result ? `  最近错误: ${t.result}` : ''
  return (
    `  ${t.id}  [${t.type}/${t.status}]  ${fireTime}${runInfo}${errInfo}\n` +
    `    ${t.prompt.slice(0, 80)}`
  )
}

export class SchedulerTool extends Tool {
  private manager = new SchedulerManager()

  get name(): string {
    return 'schedule_task'
  }

  get description(): string {
    return (
      '管理定时任务。支持两种类型：\n' +
      '  once — 单次任务，在指定时间执行一次，完成后默认自动删除（auto_delete=true）\n' +
      '  cron — 循环任务，按 cron 表达式重复执行，失败后仍继续调度\n' +
      'cron 表达式格式（5字段）: "分 时 日 月 周"，例如:\n' +
      '  "0 9 * * *"    每天早上9点\n' +
      '  "*/30 * * * *" 每30分钟\n' +
      '  "0 9 * * 1-5"  工作日早上9点'
    )
  }

  get inputSchemaZod() {
    return z.object({
      action: z.enum(['create', 'list', 'cancel', 'get'])
        .describe('create: 创建 | list: 列出 | cancel: 取消 | get: 查看详情'),
      type: z.enum(['once', 'cron']).optional()
        .describe('once: 单次任务 | cron: 循环任务（create 时必填）'),
      prompt: z.string().optional().describe('到时间后要执行的 prompt（create 时必填）'),
      run_at: z.string().optional().describe('ISO 8601 时间戳，once 任务的执行时间（type=once 时必填）'),
      cron: z.string().optional().describe('cron 表达式，5字段格式 "分 时 日 月 周"（type=cron 时必填）'),
      auto_delete: z.boolean().optional().describe('once 任务完成后是否自动删除记录（默认 true）'),
      id: z.string().optional().describe('任务 ID（cancel/get 时必填）'),
      filter_status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']).optional()
        .describe('list 时按状态过滤'),
      filter_type: z.enum(['once', 'cron']).optional().describe('list 时按类型过滤'),
    })
  }

  get outputSchemaZod() {
    return z.string()
  }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const action = String(input.action ?? '')
    const id = String(input.id ?? '')
    return { label: 'Schedule', args: id ? `${action} ${id}` : action }
  }

  async execute(args: Record<string, any>): Promise<string> {
    try {
      switch (args.action) {
        case 'create': {
          if (!args.prompt) return '❌ 需要提供 prompt'
          if (!args.type) return '❌ 需要提供 type（once 或 cron）'

          if (args.type === 'once') {
            if (!args.run_at) return '❌ once 任务需要提供 run_at（ISO 8601 时间戳）'
            const runAt = new Date(args.run_at)
            if (isNaN(runAt.getTime())) return `❌ 无效的时间格式: ${args.run_at}`
            const task = this.manager.create({
              type: 'once',
              prompt: args.prompt,
              run_at: runAt.toISOString(),
              auto_delete: args.auto_delete ?? true,
            })
            return (
              `✅ 单次任务已创建\n` +
              `  ID: ${task.id}\n` +
              `  执行时间: ${runAt.toLocaleString('zh-CN')}\n` +
              `  完成后自动删除: ${task.auto_delete ? '是' : '否'}\n` +
              `  Prompt: ${task.prompt}`
            )
          }

          if (args.type === 'cron') {
            if (!args.cron) return '❌ cron 任务需要提供 cron 表达式'
            const err = validateCron(args.cron)
            if (err) return `❌ 无效的 cron 表达式 "${args.cron}": ${err}`
            const task = this.manager.create({ type: 'cron', prompt: args.prompt, cron: args.cron })
            return (
              `✅ 循环任务已创建\n` +
              `  ID: ${task.id}\n` +
              `  Cron: ${task.cron}\n` +
              `  下次执行: ${new Date(task.next_run_at!).toLocaleString('zh-CN')}\n` +
              `  Prompt: ${task.prompt}`
            )
          }

          return `❌ 未知 type: ${args.type}`
        }

        case 'list': {
          const filter: { status?: ScheduledTaskStatus; type?: ScheduledTaskType } = {}
          if (args.filter_status) filter.status = args.filter_status
          if (args.filter_type) filter.type = args.filter_type
          const tasks = this.manager.list(Object.keys(filter).length ? filter : undefined)
          if (tasks.length === 0) return '📭 没有定时任务'
          const lines = [`⏰ 定时任务列表（共 ${tasks.length} 个）`, '']
          for (const t of tasks) lines.push(formatTask(t))
          return lines.join('\n')
        }

        case 'cancel': {
          if (!args.id) return '❌ 需要提供 id'
          const ok = this.manager.cancel(args.id)
          return ok
            ? `✅ 任务 ${args.id} 已取消`
            : `❌ 任务 ${args.id} 不存在或状态不可取消（只有 pending 状态可取消）`
        }

        case 'get': {
          if (!args.id) return '❌ 需要提供 id'
          const task = this.manager.get(args.id)
          if (!task) return `❌ 任务 ${args.id} 不存在`
          return JSON.stringify(task, null, 2)
        }

        default:
          return `❌ 未知操作: ${args.action}`
      }
    } catch (err: any) {
      return `❌ 错误: ${err.message}`
    }
  }
}
