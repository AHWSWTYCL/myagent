import { Hook, LoopEndContext } from './hook.js'
import { goalManager } from '../goal/goalManager.js'
import type { AgentTool } from '../tools/agenttool.js'
import type { TuiBridge } from '../tui/bridge.js'

/**
 * GoalHook — agent loop 结束时自动检查目标是否达成。
 *
 * 流程：
 *   1. onLoopEnd 触发（agent 声称任务完成）
 *   2. 检查是否有活跃 goal → 没有则跳过
 *   3. 递增迭代计数，超限则停用 goal 并警告
 *   4. 保存 goal 快照（防止验证期间被用户替换）
 *   5. spawn verifier sub-agent（goal-verifier，纯只读），传入 goal + agent 输出 + 上下文
 *   6. 校验 goal 快照是否仍然有效 → 被替换则放弃本轮结果
 *   7. verifier 返回 APPROVED → goal 达成，停用
 *   8. verifier 返回 NEEDS_REVISION → enqueue feedback 消息，触发新一轮 turn
 */
export class GoalHook implements Hook {
  name = 'GoalHook'

  constructor(
    private agentTool: AgentTool,
    private enqueueUserMessage: (msg: string) => void,
    private bridge: TuiBridge,
  ) {}

  async onLoopEnd(ctx: LoopEndContext): Promise<void> {
    console.error('[GoalHook] onLoopEnd called, isActive=', goalManager.isActive(), 'goal=', goalManager.getGoal())
    if (!goalManager.isActive()) return

    // 先检查上限，再递增（保证第 N 次调用时 iter=N，执行 N 次后停止）
    if (goalManager.isMaxIterationsReached()) {
      const goal = goalManager.getGoal()
      this.bridge.emitMessage(
        'system',
        `⚠️ 目标 "${goal}" 在 ${goalManager.getMaxIterations()} 次迭代后仍未达成，已停止检查。请用 /goal 重新设置或调整目标。`,
      )
      goalManager.deactivate()
      return
    }

    goalManager.incrementIteration()
    const iter = goalManager.getIteration()
    const max = goalManager.getMaxIterations()

    const goal = goalManager.getGoal()!
    // 保存快照，防止 verifier 运行期间 goal 被 /goal clear 或 /goal set 替换
    const goalSnapshot = goal

    this.bridge.emitStatus(`目标检查中...（第 ${iter}/${max} 次）`)

    try {
      const result = await this.runVerifier(goalSnapshot, ctx)

      // verifier 运行期间 goal 被替换了，放弃本轮结果
      if (goalManager.getGoal() !== goalSnapshot || !goalManager.isActive()) {
        this.bridge.emitMessage(
          'system',
          `⚠️ 目标已被更改或清除，跳过本轮检查结果。`,
        )
        return
      }

      if (result.approved) {
        this.bridge.emitMessage('system', `✅ 目标达成：${goalSnapshot}`)
        goalManager.deactivate()
      } else {
        const feedback = this.buildFeedback(goalSnapshot, result.feedback, iter, max)
        this.bridge.emitMessage('system', `❌ 目标未达成（第 ${iter}/${max} 次），反馈已发送给 agent`)
        this.enqueueUserMessage(feedback)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.bridge.emitMessage('system', `⚠️ 目标检查失败：${msg}，跳过本轮检查`)
    }
  }

  /**
   * 构建 verifier prompt 并执行。
   */
  private async runVerifier(
    goal: string,
    ctx: LoopEndContext,
  ): Promise<{ approved: boolean; feedback: string }> {
    const messageSummary = this.summarizeMessages(ctx.messages, 5)

    const verifierPrompt = `## Goal (Success Criterion)
${goal}

## Agent's Final Output
${ctx.assistantText.slice(-3000) || '(empty)'}

## Recent Conversation Context
${messageSummary}

## Instructions
1. Evaluate whether the goal has been FULLY achieved — "tried" is not enough.
2. Read actual files (using your tools) to verify claims, don't just trust the agent's words.
3. If the user didn't specify a concrete criterion, infer a reasonable standard — err on the strict side.
4. Remember: you are an EVALUATOR. Point out problems; the main agent will fix them.`

    const rawResult = await this.agentTool.execute({
      agent: 'goal-verifier',
      task: verifierPrompt,
    })

    return this.parseVerifierResult(rawResult)
  }

  /**
   * 解析 verifier 返回的文本。
   * 期望格式：首行 APPROVED 或 NEEDS_REVISION。
   */
  private parseVerifierResult(raw: string): { approved: boolean; feedback: string } {
    const firstLine = raw.trim().split('\n')[0]?.trim().toUpperCase() ?? ''

    if (firstLine.startsWith('APPROVED')) {
      return { approved: true, feedback: raw.trim() }
    }

    if (firstLine.startsWith('NEEDS_REVISION')) {
      return { approved: false, feedback: raw.trim() }
    }

    // 模糊输出：保守处理，认为未达成
    return {
      approved: false,
      feedback: `验证器响应格式不清（期望 APPROVED 或 NEEDS_REVISION）：\n${raw.trim()}`,
    }
  }

  /**
   * 构建注入给 agent 的 feedback 消息。
   */
  private buildFeedback(
    goal: string,
    verifierFeedback: string,
    iter: number,
    max: number,
  ): string {
    return [
      `[Goal Check — 第 ${iter}/${max} 次]`,
      `目标：「${goal}」`,
      ``,
      `验证结果：未达成`,
      ``,
      verifierFeedback,
      ``,
      `请根据以上反馈继续改进。如果你认为目标不合理或无法达成，请向用户说明。`,
    ].join('\n')
  }

  /**
   * 从消息历史中提取摘要文本。
   * 截取最后 N 条消息，跳过纯 tool_result，限制每条长度。
   */
  private summarizeMessages(
    messages: LoopEndContext['messages'],
    maxCount: number,
  ): string {
    // 过滤：跳过纯 tool_result（无 text block 的 user 消息）
    const filtered = messages.filter(m => {
      if (m.role === 'user' && Array.isArray(m.content)) {
        const hasText = m.content.some(c => c.type === 'text')
        if (!hasText) return false
      }
      return true
    })

    const recent = filtered.slice(-maxCount)
    return recent
      .map(m => {
        const role = m.role
        // 对于 tool_use 和 tool_result，做轻量摘要而非全量序列化
        let content: string
        if (typeof m.content === 'string') {
          content = m.content
        } else {
          content = m.content
            .map(c => {
              if (c.type === 'text') return c.text
              if (c.type === 'tool_use') return `[tool_use: ${c.name}]`
              if (c.type === 'tool_result') return `[tool_result: ${(c as any).tool_use_id?.slice(0, 8)}...]`
              return `[${c.type}]`
            })
            .join('\n')
        }
        const truncated =
          content.length > 500 ? content.slice(0, 497) + '...' : content
        return `[${role}] ${truncated}`
      })
      .join('\n\n')
  }
}
