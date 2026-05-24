import Anthropic from '@anthropic-ai/sdk'
import { Hook, TurnEndContext } from './hook.js'
import { runRetrospective } from '../retrospective/retrospective.js'
import { SkillManager } from '../skills/skillmanager.js'
import type { TuiBridge } from '../tui/bridge.js'

/**
 * 内层每 N 个 turn 触发一次复盘（异步，不阻塞主循环）。
 * 之前在 REPL 层按 runTurn 计数，现在按 queryLoop iteration 计数，
 * 与 Claude Code 一致。
 */
export class RetrospectiveHook implements Hook {
  name = 'RetrospectiveHook'

  private turnsSince = 0
  private running = false

  constructor(
    private client: Anthropic,
    private skillManager: SkillManager,
    private bridge: TuiBridge,
    private threshold: number,
  ) {}

  async onTurnEnd(ctx: TurnEndContext): Promise<void> {
    this.turnsSince++
    if (this.turnsSince < this.threshold) return
    if (this.running) return
    this.turnsSince = 0
    this.running = true

    const snapshot = [...ctx.messages]
    runRetrospective(this.client, snapshot, this.skillManager, msg => this.bridge.emitStatus(msg))
      .catch(err => console.error('[retrospective]', err))
      .finally(() => { this.running = false })
  }
}
