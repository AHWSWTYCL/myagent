import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import type { ChoiceQuestion, ChoiceResult } from '../tui/types.js'

export class ExitPlanModeTool extends Tool {
  /** 注入的 bridge 回调 — 由 bootstrap.ts 注入，确保状态写入走单一入口 */
  private onExit: (() => string) | null = null

  /** TUI 交互回调 — 用于在 tool 内部直接阻塞询问用户，不依赖 LLM 判断 */
  private askChoice: ((questions: ChoiceQuestion[]) => Promise<ChoiceResult>) | null = null
  private askQuestion: ((prompt: string) => Promise<string>) | null = null

  /** bootstrap.ts 注入回调 */
  inject(
    onExit: () => string,
    askChoice?: (questions: ChoiceQuestion[]) => Promise<ChoiceResult>,
    askQuestion?: (prompt: string) => Promise<string>,
  ): void {
    this.onExit = onExit
    this.askChoice = askChoice ?? null
    this.askQuestion = askQuestion ?? null
  }

  get name(): string {
    return 'exit_plan_mode'
  }

  get description(): string {
    return '退出 Plan Mode（计划模式）。首次调用时（不带 confirm），系统会提示你先询问用户是否接受计划。用户确认后，带上 confirm=true 再次调用来真正退出。'
  }

  get inputSchemaZod() {
    return z.object({
      confirm: z.boolean().optional()
        .describe('用户确认接受计划后设为 true。首次调用时不传或设为 false。'),
    })
  }

  get outputSchemaZod() {
    return z.string()
  }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const confirm = input.confirm ? ' confirm' : ''
    return { label: 'ExitPlanMode', args: confirm }
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: { confirm?: boolean }): Promise<string> {
    if (!this.onExit) return 'Error: ExitPlanModeTool not properly initialized.'

    if (!args.confirm) {
      // ── 第一阶段：询问用户是否接受计划 ──────────────────────────────
      // 修复：不再依赖 LLM 遵守文本指令去调 ask_user_choice，
      // 而是在 tool 内部直接调用 bridge 回调阻塞等待用户输入。
      // 这确保用户一定会被询问，LLM 无法绕过。
      if (this.askChoice) {
        const result = await this.askChoice([
          {
            id: 'plan_confirm',
            prompt: 'Plan is ready. Would you like to proceed?',
            options: [
              { value: 'accept', label: 'Yes, proceed with the plan' },
              { value: 'change', label: 'Tell me what to change' },
            ],
          },
        ])

        if (result.status === 'cancelled') {
          return 'User cancelled. You remain in plan mode. You may revise the plan or present it differently before trying exit_plan_mode again.'
        }

        const answer = result.answers?.plan_confirm

        if (answer === 'accept') {
          // 用户接受 → 直接退出 plan mode
          const restoredMode = this.onExit()
          if (restoredMode === 'plan') {
            return 'Still in plan mode (exitPlanMode failed unexpectedly).'
          }
          return `Exited plan mode. Restored to "${restoredMode}" mode.\n\nPlan has been accepted by the user. You may now proceed with implementation — you can write code, run commands, and make changes as needed.`
        }

        if (answer === 'change') {
          // 用户想修改 → 获取反馈
          const feedback = this.askQuestion
            ? await this.askQuestion('What would you like to change about the plan?')
            : '(no feedback input available)'
          return `PLAN FEEDBACK FROM USER:\n\n${feedback}\n\nYou remain in plan mode. Revise the plan based on this feedback, then call exit_plan_mode again to present the revised plan.`
        }

        return 'You remain in plan mode.'
      }

      // ── 无 TUI 回调（headless/debug 模式）：回退到文本提示 ──
      // 这种情况下 LLM 仍需要通过 ask_user_choice 询问用户
      return `PLAN EXIT — USER CONFIRMATION REQUIRED

Before exiting plan mode, you MUST ask the user if they accept the plan.

Use ask_user_choice with these options:
  - Option 1: "Accept the plan — exit plan mode and proceed to implementation"
    → After user selects this, call exit_plan_mode(confirm=true)
  - Option 2: "Revise the plan — I have feedback"
    → After user selects this, call ask_user to get their feedback, then revise the plan and try exit_plan_mode again.

You remain in plan mode until confirm=true is passed.`
    }

    // ── 第二阶段：真正退出 plan mode（confirm=true 路径）─────────
    // onExit 回调内部调用 bridge.exitPlanMode()，返回退出后的新 mode
    const restoredMode = this.onExit()

    if (restoredMode === 'plan') {
      return 'Still in plan mode (exitPlanMode failed unexpectedly).'
    }

    return `Exited plan mode. Restored to "${restoredMode}" mode.

Plan has been accepted by the user. You may now proceed with implementation — you can write code, run commands, and make changes as needed.`
  }
}
