import { Command } from './command.js'
import { advisorConfig } from '../llm/advisor-config.js'
import type { ChoiceQuestion, ChoiceResult } from '../tui/types.js'

export class AdvisorCommand extends Command {
  constructor(
    private askChoice: (questions: ChoiceQuestion[]) => Promise<ChoiceResult>,
  ) {
    super()
  }

  get name(): string {
    return 'advisor'
  }

  get description(): string {
    return '管理 advisor agent 的模型（Claude Sonnet / Opus）'
  }

  get usage(): string {
    return '/advisor              → 交互式选择 advisor 模型\n  /advisor sonnet       → 切换为 Claude Sonnet 4.6\n  /advisor opus         → 切换为 Claude Opus 4.7\n  /advisor info         → 查看当前 advisor 模型'
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

    // 别名：sonnet / opus
    if (subcommand === 'sonnet') {
      this.switchTo('claude-sonnet-4-6')
      return
    }

    if (subcommand === 'opus') {
      this.switchTo('claude-opus-4-7')
      return
    }

    // 有参数 → 尝试直接按模型名切换
    if (subcommand) {
      const success = advisorConfig.setCurrent(subcommand)
      if (success) {
        const info = advisorConfig.find(subcommand)!
        console.log(`[advisor] 已切换模型 → ${info.displayName} (${info.name})`)
        console.log(`  ${info.description}`)
      } else {
        console.log(`错误：未知 advisor 模型 "${subcommand}"`)
        console.log(`可用模型：${advisorConfig.list().map(m => m.name).join(', ')}`)
        console.log(`快捷切换：/advisor sonnet | /advisor opus`)
      }
      return
    }

    // 无参数 → 交互式选择
    await this.handleInteractive()
  }

  private switchTo(modelName: string): void {
    const success = advisorConfig.setCurrent(modelName)
    if (success) {
      const info = advisorConfig.find(modelName)!
      console.log(`[advisor] 已切换模型 → ${info.displayName} (${info.name})`)
      console.log(`  ${info.description}`)
    }
  }

  private async handleInteractive(): Promise<void> {
    const models = advisorConfig.list()
    const current = advisorConfig.getCurrent()
    const currentInfo = advisorConfig.find(current)
    const currentLabel = currentInfo ? currentInfo.displayName : current

    const result = await this.askChoice([{
      id: 'advisor-model',
      prompt: `选择 Advisor 模型（当前：${currentLabel}）`,
      options: models.map(m => ({
        value: m.name,
        label: `${m.displayName} — ${m.description}${m.name === current ? '  ← 当前' : ''}`,
      })),
    }])

    if (result.status === 'cancelled') {
      console.log('已取消')
      return
    }

    const chosen = result.answers['advisor-model']
    if (!chosen || chosen === current) {
      if (chosen === current) {
        console.log(`当前已是 ${currentLabel}，无需切换`)
      }
      return
    }

    this.switchTo(chosen)
  }

  private handleList(): void {
    const models = advisorConfig.list()
    const current = advisorConfig.getCurrent()

    console.log(`Advisor 可用模型（共 ${models.length} 个）：`)
    for (const m of models) {
      const marker = m.name === current ? ' ← 当前' : ''
      console.log(`  ${m.name} — ${m.displayName}${marker}`)
      console.log(`    ${m.description}`)
    }
  }

  private handleInfo(): void {
    const current = advisorConfig.getCurrent()
    const info = advisorConfig.find(current)

    if (!info) {
      console.log(`当前 advisor 模型：${current}（未在预定义列表中）`)
      return
    }

    console.log(`Advisor 当前模型：${info.displayName}`)
    console.log(`  API 名称：${info.name}`)
    console.log(`  说明：${info.description}`)
    console.log(`  Provider：Anthropic（原生 API）`)
    console.log()
    console.log(`快捷切换：/advisor sonnet | /advisor opus`)
    console.log(`交互式切换：/advisor`)
  }
}
