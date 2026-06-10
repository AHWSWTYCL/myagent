import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'

export class ExitPlanModeTool extends Tool {
  /** 注入的 bridge 回调 — 由 bootstrap.ts 注入，确保状态写入走单一入口 */
  private onExit: (() => string) | null = null

  /** bootstrap.ts 注入回调 */
  inject(onExit: () => string): void {
    this.onExit = onExit
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
      // ── 第一阶段：提示 LLM 询问用户 ──────────────────────────────
      return `PLAN EXIT — USER CONFIRMATION REQUIRED

Before exiting plan mode, you MUST ask the user if they accept the plan.

Use ask_user_choice with these options:
  - Option 1: "Accept the plan — exit plan mode and proceed to implementation"
    → After user selects this, call exit_plan_mode(confirm=true)
  - Option 2: "Revise the plan — I have feedback"
    → After user selects this, call ask_user to get their feedback, then revise the plan and try exit_plan_mode again.

You remain in plan mode until confirm=true is passed.`
    }

    // ── 第二阶段：真正退出 plan mode ─────────────────────────────────
    // onExit 回调内部调用 bridge.exitPlanMode()，返回退出后的新 mode
    const restoredMode = this.onExit()

    if (restoredMode === 'plan') {
      return 'Still in plan mode (exitPlanMode failed unexpectedly).'
    }

    return `Exited plan mode. Restored to "${restoredMode}" mode.

Plan has been accepted by the user. You may now proceed with implementation — you can write code, run commands, and make changes as needed.`
  }
}
