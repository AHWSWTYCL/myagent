import { Command } from './command.js'
import type Anthropic from '@anthropic-ai/sdk'
import type { SkillManager } from '../skills/skillmanager.js'
import type { TuiBridge } from '../tui/bridge.js'
import { runRetrospective } from '../retrospective/retrospective.js'

export class RetrospectiveCommand extends Command {
  constructor(
    private client: Anthropic,
    private messages: () => Anthropic.MessageParam[],
    private skillManager: SkillManager,
    private bridge: TuiBridge,
  ) {
    super()
  }

  get name(): string {
    return 'retrospective'
  }

  get description(): string {
    return '手动触发复盘，分析对话历史并提炼技能'
  }

  get usage(): string {
    return '/retrospective'
  }

  async execute(args: string[]): Promise<void> {
    const snapshot = this.messages()
    if (snapshot.length === 0) {
      console.log('当前没有对话记录，无需复盘。')
      return
    }

    console.log(`开始复盘（共 ${snapshot.length} 条消息）...`)
    this.bridge.emitStatus('复盘中...')

    try {
      await runRetrospective(
        this.client,
        snapshot,
        this.skillManager,
        (msg: string) => {
          this.bridge.emitStatus(msg)
        },
      )
      console.log('复盘完成。使用 /skill list 查看已有 skill，或继续对话。')
    } catch (err) {
      console.log(`复盘出错：${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
