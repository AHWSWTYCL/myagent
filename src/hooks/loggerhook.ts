import { Hook, HookContext, HookResult } from './hook.js'
import type { TuiBridge } from '../tui/bridge.js'
import type { EditDiffResult } from '../tools/edittool.js'

export class LoggerHook implements Hook {
  name = 'LoggerHook'

  constructor(private bridge: TuiBridge) {}

  async onToolCall(_ctx: HookContext): Promise<HookResult> {
    return { action: 'continue' }
  }

  async onToolResult(ctx: HookContext): Promise<void> {
    // read_file：只显示路径，不显示内容（内容太长且干扰 TUI）
    if (ctx.toolName === 'read_file') {
      const path = (ctx.toolInput as Record<string, unknown>)?.path ?? ''
      this.bridge.emitMessage('tool', `◀ read_file  ${path}`)
      return
    }

    // edit_file：解析结构化的 diff 数据，走专门的 diff 渲染
    if (ctx.toolName === 'edit_file') {
      const result = ctx.toolResult ?? ''
      try {
        const parsed = JSON.parse(result) as { summary: string; diff: EditDiffResult }
        if (parsed.diff?.lines) {
          this.bridge.emitEditDiff(parsed.diff.filePath, parsed.diff.lines, parsed.diff.additions, parsed.diff.removals)
          return
        }
      } catch {
        // 不是 JSON 格式，回退到普通消息
      }
    }

    const result = ctx.toolResult ?? ''
    const preview = result.length > 300 ? result.slice(0, 300) + ' …' : result
    this.bridge.emitMessage('tool', `◀ ${ctx.toolName}: ${preview}`)
  }
}
