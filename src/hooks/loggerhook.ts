import { Hook, HookContext, HookResult } from './hook.js'

// 打印每次 tool 调用和结果，方便调试
export class LoggerHook implements Hook {
  name = 'LoggerHook'

  async onToolCall(ctx: HookContext): Promise<HookResult> {
    const inputStr = JSON.stringify(ctx.toolInput, null, 2)
    console.log(`\n[logger] ▶ tool_call: ${ctx.toolName}`)
    console.log(`[logger]   input: ${inputStr}`)
    return { action: 'continue' }
  }

  async onToolResult(ctx: HookContext): Promise<void> {
    const preview = (ctx.toolResult ?? '').slice(0, 200)
    const truncated = (ctx.toolResult ?? '').length > 200 ? '...(truncated)' : ''
    console.log(`[logger] ◀ tool_result: ${ctx.toolName}`)
    console.log(`[logger]   result: ${preview}${truncated}`)
  }
}
