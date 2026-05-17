// Hook 系统的核心接口定义

export interface HookContext {
  toolName: string
  toolInput: unknown
  toolResult?: string
}

// Hook 执行结果：continue 继续执行，block 阻断
export type HookResult =
  | { action: 'continue' }
  | { action: 'block'; reason: string }

export interface Hook {
  name: string
  // tool 调用前触发，返回 block 可阻断执行
  onToolCall?(ctx: HookContext): Promise<HookResult>
  // tool 执行后触发，可观察结果
  onToolResult?(ctx: HookContext): Promise<void>
}

export class HookManager {
  private hooks: Hook[] = []

  register(hook: Hook) {
    this.hooks.push(hook)
    console.log(`[hooks] Registered: ${hook.name}`)
  }

  // 依次执行所有 onToolCall，任意一个 block 则中断
  async runOnToolCall(ctx: HookContext): Promise<HookResult> {
    for (const hook of this.hooks) {
      if (!hook.onToolCall) continue
      const result = await hook.onToolCall(ctx)
      if (result.action === 'block') {
        console.log(`[hooks] ${hook.name} blocked tool "${ctx.toolName}": ${result.reason}`)
        return result
      }
    }
    return { action: 'continue' }
  }

  // 依次执行所有 onToolResult（纯观察，不阻断）
  async runOnToolResult(ctx: HookContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onToolResult) continue
      await hook.onToolResult(ctx)
    }
  }
}
