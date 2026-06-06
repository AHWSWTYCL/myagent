/**
 * TeamCommand — `/team <task>`
 *
 * 一行启动 leader agent 完成复杂任务。
 * 实现：把"调用 leader agent，task=..."这段 prompt 通过 messageQueue 入队，
 * 让主 agent 下一个 turn 自动消费，等价于用户手输的派活语句。
 */

import { Command } from './command.js'

export class TeamCommand extends Command {
  constructor(private readonly enqueue: (msg: string) => void) {
    super()
  }

  get name(): string { return 'team' }

  get description(): string {
    return '启动 leader agent 协调团队完成复杂任务'
  }

  get usage(): string {
    return '/team <task description>'
  }

  async execute(args: string[]): Promise<void> {
    const task = args.join(' ').trim()
    if (!task) {
      console.log('用法: /team <复杂任务描述>')
      console.log('示例: /team 把 src/foo.ts 拆分成 model/view/controller 三个文件')
      console.log('')
      console.log('leader 会自动拆任务、启动 teammate worker、通过邮箱协调到完成。')
      return
    }
    const escaped = task.replace(/"/g, '\\"')
    const prompt =
      `用 agent 工具调用 leader，且必须 background=true（这样 leader 后台跑完会以 <bg-task> 通知方式推回完整总结，` +
      `而不是被同步 sub-agent stream abort 截掉，主对话也能看到 leader 派活/收尾的完整过程）。\n\n` +
      `参数：agent="leader", background=true, task="${escaped}"`
    this.enqueue(prompt)
    console.log(`已派给 leader（后台模式），task: ${task}`)
    console.log('（提示加入消息队列，主 agent 在下一个 turn 自动开始；leader 完成后会通过 bg-task 通知回报）')
  }
}
