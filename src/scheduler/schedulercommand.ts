import { Command } from '../commands/command.js'
import { SchedulerManager, validateCron } from './schedulermanager.js'
import { ScheduledTask, ScheduledTaskStatus, ScheduledTaskType } from './scheduledtask.js'

const STATUSES: ScheduledTaskStatus[] = ['pending', 'running', 'done', 'failed', 'cancelled']
const TYPES: ScheduledTaskType[] = ['once', 'cron']

function formatTaskLine(t: ScheduledTask): string {
  const fireTime = t.type === 'once'
    ? new Date(t.run_at!).toLocaleString('zh-CN')
    : `${t.cron}  →  ${new Date(t.next_run_at!).toLocaleString('zh-CN')}`
  const runInfo = t.run_count > 0 ? `  (已执行 ${t.run_count} 次)` : ''
  return `  ${t.id}  [${t.type}/${t.status}]  ${fireTime}${runInfo}\n    ${t.prompt.slice(0, 80)}`
}

export class SchedulerCommand extends Command {
  private manager = new SchedulerManager()

  get name(): string { return 'schedule' }
  get description(): string { return '管理定时任务（once 单次 / cron 循环）' }
  get usage(): string {
    return [
      '  /schedule list [status] [type]   列出定时任务',
      '  /schedule show <id>              查看任务详情',
      '  /schedule cancel <id>            取消 pending 任务',
    ].join('\n')
  }

  async execute(args: string[]): Promise<void> {
    const sub = args[0]

    switch (sub) {
      case 'list': {
        const filter: { status?: ScheduledTaskStatus; type?: ScheduledTaskType } = {}
        for (const arg of args.slice(1)) {
          if (STATUSES.includes(arg as ScheduledTaskStatus)) filter.status = arg as ScheduledTaskStatus
          else if (TYPES.includes(arg as ScheduledTaskType)) filter.type = arg as ScheduledTaskType
          else console.log(`⚠️  忽略未知过滤参数: ${arg}`)
        }
        const tasks = this.manager.list(Object.keys(filter).length ? filter : undefined)
        if (tasks.length === 0) {
          console.log('📭 没有定时任务')
          return
        }
        const desc = [filter.type, filter.status].filter(Boolean).join(', ')
        console.log(`⏰ 定时任务列表（共 ${tasks.length} 个）${desc ? `  [${desc}]` : ''}`)
        console.log('')
        for (const t of tasks) console.log(formatTaskLine(t))
        break
      }

      case 'show': {
        const id = args[1]
        if (!id) { console.log('❌ 用法: /schedule show <id>'); return }
        const task = this.manager.get(id)
        if (!task) { console.log(`❌ 任务 ${id} 不存在`); return }
        console.log(`⏰ 定时任务: ${task.id}`)
        console.log(`  类型: ${task.type}`)
        console.log(`  状态: ${task.status}`)
        if (task.type === 'once') {
          console.log(`  执行时间: ${new Date(task.run_at!).toLocaleString('zh-CN')}`)
          console.log(`  完成后删除: ${task.auto_delete ? '是' : '否'}`)
        } else {
          console.log(`  Cron: ${task.cron}`)
          console.log(`  下次执行: ${new Date(task.next_run_at!).toLocaleString('zh-CN')}`)
        }
        console.log(`  Prompt: ${task.prompt}`)
        console.log(`  已执行次数: ${task.run_count}`)
        if (task.last_run_at) console.log(`  上次执行: ${new Date(task.last_run_at).toLocaleString('zh-CN')}`)
        if (task.result) console.log(`  最近结果/错误: ${task.result}`)
        console.log(`  创建时间: ${new Date(task.created_at).toLocaleString('zh-CN')}`)
        break
      }

      case 'cancel': {
        const id = args[1]
        if (!id) { console.log('❌ 用法: /schedule cancel <id>'); return }
        const ok = this.manager.cancel(id)
        console.log(ok ? `✅ 已取消 ${id}` : `❌ 任务 ${id} 不存在或已不可取消`)
        break
      }

      default:
        console.log(`未知子命令: ${sub ?? '(空)'}`)
        console.log(`用法:\n${this.usage}`)
    }
  }
}
