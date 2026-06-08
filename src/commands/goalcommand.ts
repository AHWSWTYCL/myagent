import { Command } from './command.js'
import { goalManager } from '../goal/goalManager.js'

export class GoalCommand extends Command {
  get name(): string {
    return 'goal'
  }

  get description(): string {
    return '设置任务完成标准，agent 完成后自动验证是否达标'
  }

  get usage(): string {
    return '/goal <条件>          → 设置目标，如 /goal "所有测试通过"\n  /goal                  → 查看当前目标\n  /goal clear            → 清除目标'
  }

  async execute(args: string[]): Promise<void> {
    const input = args.join(' ').trim()

    if (!input) {
      // 查看当前目标
      if (goalManager.isActive()) {
        const iter = goalManager.getIteration()
        const max = goalManager.getMaxIterations()
        console.log(`当前目标：${goalManager.getGoal()}`)
        console.log(`状态：激活中（已检查 ${iter}/${max} 次）`)
      } else {
        console.log('当前无活跃目标。')
        console.log(`用法：/goal <条件>  例如 /goal "所有测试用例通过"`)
      }
      return
    }

    if (input === 'clear' || input === 'off') {
      if (goalManager.isActive()) {
        goalManager.clear()
        console.log('目标已清除。')
      } else {
        console.log('当前无活跃目标，无需清除。')
      }
      return
    }

    // 设置目标
    goalManager.setGoal(input)
    console.log(`目标已设置：${input}`)
    console.log(`Agent 完成后将自动验证是否达标（最多 ${goalManager.getMaxIterations()} 次迭代）。`)
  }
}
