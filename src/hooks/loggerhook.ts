import { Hook, HookContext, HookResult } from './hook.js'
import type { TuiBridge } from '../tui/bridge.js'

export class LoggerHook implements Hook {
  name = 'LoggerHook'

  constructor(private bridge: TuiBridge) {}

  async onToolCall(_ctx: HookContext): Promise<HookResult> {
    return { action: 'continue' }
  }

  async onToolResult(ctx: HookContext): Promise<void> {
    const result = ctx.toolResult ?? ''
    const preview = result.length > 300 ? result.slice(0, 300) + ' …' : result
    this.bridge.emitMessage('tool', `◀ ${ctx.toolName}: ${preview}`)
  }
}
