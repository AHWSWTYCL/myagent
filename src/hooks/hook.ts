// Hook 系统的核心接口定义

import type Anthropic from '@anthropic-ai/sdk'

export interface HookContext {
  toolName: string
  toolInput: unknown
  toolResult?: string
}

export interface TurnEndContext {
  /** 当前会话消息（hook 内只读，按需自行 copy） */
  messages: Anthropic.MessageParam[]
  /** 本 turn 模型最终输出的文本 */
  assistantText: string
  /** 本轮 runTurn 的原始用户输入；可选，子 agent / 工具内部循环可不传 */
  userInput?: string
}

/**
 * runAgentLoopStream 整体退出后触发（非 background 分支）。
 * 与 onTurnEnd 的区别：onTurnEnd 每轮 LLM 调用后都触发，
 * onLoopEnd 只在整个 loop 彻底结束时（end_turn + 无 drain 内容）触发一次。
 *
 * 适用场景：目标达成检查、会话摘要等"agent 停下来后"的副作用。
 * 回调内可做 side effect（如 enqueue message），但不影响当前 runTurn 的控制流。
 */
export interface LoopEndContext {
  /** 当前会话消息（只读） */
  messages: Anthropic.MessageParam[]
  /** 本 loop 中所有 turn 的 assistant 文本拼接 */
  assistantText: string
  /** 本轮 runTurn 的原始用户输入 */
  userInput?: string
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
  // 内层 queryLoop 每一 turn 模型出 text 后触发（纯观察 / 副作用）
  onTurnEnd?(ctx: TurnEndContext): Promise<void>
  // queryLoop 全部结束后触发（纯观察 / 副作用；不阻断主流程）
  onLoopEnd?(ctx: LoopEndContext): Promise<void>
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

  // 内层 turn 结束时调用（纯观察，不阻断；hook 内部异常被吞掉以免影响主循环）
  async runOnTurnEnd(ctx: TurnEndContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onTurnEnd) continue
      try {
        await hook.onTurnEnd(ctx)
      } catch (err) {
        console.error(`[hooks] ${hook.name}.onTurnEnd error:`, err)
      }
    }
  }

  // queryLoop 全部结束后调用（纯观察，不阻断；hook 内部异常被吞掉以免影响主循环）
  async runOnLoopEnd(ctx: LoopEndContext): Promise<void> {
    for (const hook of this.hooks) {
      if (!hook.onLoopEnd) continue
      try {
        await hook.onLoopEnd(ctx)
      } catch (err) {
        console.error(`[hooks] ${hook.name}.onLoopEnd error:`, err)
      }
    }
  }
}
