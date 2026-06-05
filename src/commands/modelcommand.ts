import { Command } from './command.js'
import { modelConfig } from '../llm/model-config.js'
import type { ChoiceQuestion, ChoiceResult } from '../tui/types.js'

export class ModelCommand extends Command {
  constructor(
    private askChoice: (questions: ChoiceQuestion[]) => Promise<ChoiceResult>,
  ) {
    super()
  }

  get name(): string {
    return 'model'
  }

  get description(): string {
    return '查看或切换当前使用的模型'
  }

  get usage(): string {
    return '/model           → 交互式选择模型\n  /model <name>    → 直接切换（如 /model deepseek-v4-flash）\n  /model info      → 查看当前模型详情'
  }

  async execute(args: string[]): Promise<void> {
    const subcommand = args[0]

    if (subcommand === 'info') {
      this.handleInfo()
      return
    }

    if (subcommand === 'list') {
      this.handleList()
      return
    }

    // 有参数 → 尝试直接切换
    if (subcommand) {
      const success = modelConfig.setCurrent(subcommand)
      if (success) {
        const info = modelConfig.find(subcommand)!
        console.log(`已切换模型 → ${info.displayName} (${info.name})`)
        console.log(`  ${info.description}`)
      } else {
        console.log(`错误：未知模型 "${subcommand}"`)
        console.log(`可用模型：${modelConfig.list().map(m => m.name).join(', ')}`)
        console.log(`提示：输入 /model 可交互式选择`)
      }
      return
    }

    // 无参数 → 交互式选择
    await this.handleInteractive()
  }

  private async handleInteractive(): Promise<void> {
    const models = modelConfig.list()
    const current = modelConfig.getCurrent()

    const currentInfo = modelConfig.find(current)
    const currentLabel = currentInfo ? `${currentInfo.displayName}` : current

    const result = await this.askChoice([{
      id: 'model',
      prompt: `选择模型（当前：${currentLabel}）`,
      options: models.map(m => ({
        value: m.name,
        label: `${m.displayName} — ${m.description}${m.name === current ? '  ← 当前' : ''}`,
      })),
    }])

    if (result.status === 'cancelled') {
      console.log('已取消')
      return
    }

    const chosen = result.answers['model']
    if (!chosen || chosen === current) {
      // 没选或选了当前的，不做任何事
      if (chosen === current) {
        console.log(`当前已是 ${currentLabel}，无需切换`)
      }
      return
    }

    modelConfig.setCurrent(chosen)
    const info = modelConfig.find(chosen)!
    console.log(`已切换模型 → ${info.displayName} (${info.name})`)
    console.log(`  ${info.description}`)
  }

  private handleList(): void {
    const models = modelConfig.list()
    const current = modelConfig.getCurrent()

    console.log(`可用模型（共 ${models.length} 个）：`)
    for (const m of models) {
      const marker = m.name === current ? ' ← 当前' : ''
      console.log(`  ${m.name} — ${m.displayName}${marker}`)
      console.log(`    ${m.description}`)
    }
  }

  private handleInfo(): void {
    const current = modelConfig.getCurrent()
    const info = modelConfig.find(current)

    if (!info) {
      console.log(`当前模型：${current}（未在预定义列表中）`)
      return
    }

    console.log(`当前模型：${info.displayName}`)
    console.log(`  API 名称：${info.name}`)
    console.log(`  说明：${info.description}`)
    console.log()
    console.log(`交互式切换：/model`)
    console.log(`直接切换：/model <model_name>`)
    console.log(`查看全部：/model list`)
  }
}
