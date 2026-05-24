import { Hook, TurnEndContext } from './hook.js'
import { extractMemoryFromTurn, appendMemories } from '../memory/extract.js'
import type { TuiBridge } from '../tui/bridge.js'

/**
 * 每个内层 turn 结束后异步抽取记忆。
 * 不阻塞下一 turn，错误吞掉只打日志。
 */
export class MemoryExtractHook implements Hook {
  name = 'MemoryExtractHook'

  constructor(private bridge: TuiBridge) {}

  async onTurnEnd(ctx: TurnEndContext): Promise<void> {
    if (!ctx.userInput) return
    extractMemoryFromTurn(ctx.userInput, ctx.assistantText)
      .then(items => {
        if (items.length === 0) return
        const added = appendMemories(items)
        if (added > 0) {
          this.bridge.emitMessage('system', `[memory] +${added} new memor${added === 1 ? 'y' : 'ies'}`)
        }
      })
      .catch(err => console.error('[extract]', err))
  }
}
