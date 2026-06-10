import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { attachmentQueue } from '../attachment/queue.js'
import { PlanModeAttachment } from '../attachment/planMode.js'

export class EnterPlanModeTool extends Tool {
  /** 注入的 bridge 回调 — 由 bootstrap.ts 注入，确保状态写入走单一入口 */
  private onEnter: (() => string) | null = null

  /** bootstrap.ts 注入回调 */
  inject(onEnter: () => string): void {
    this.onEnter = onEnter
  }

  get name(): string {
    return 'enter_plan_mode'
  }

  get description(): string {
    return '进入 Plan Mode（计划模式）。在此模式下，你只能探索代码和编写计划，不能修改任何代码。当你需要先做调研和方案设计、而非直接动手改代码时使用。'
  }

  get inputSchemaZod() {
    return z.object({})
  }

  get outputSchemaZod() {
    return z.string()
  }

  renderToolUseMessage(_input: Record<string, unknown>): ToolRenderHeader {
    return { label: 'EnterPlanMode', args: '' }
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(): Promise<string> {
    if (!this.onEnter) return 'Error: EnterPlanModeTool not properly initialized.'

    const previousMode = this.onEnter()

    if (previousMode === 'plan') return 'Already in plan mode.'

    // 首次注入完整版 plan mode prompt
    attachmentQueue.enqueue(new PlanModeAttachment(true))

    return `Entered plan mode (previous mode: ${previousMode}).

You are now in Plan Mode. Key rules:
- You may ONLY explore (read_file, list_dir, grep, glob, web_search, web_fetch) and create plans.
- You CANNOT modify code, write files, or run bash commands.
- Present your plan directly in your Markdown reply — do NOT use write_file.
- When your plan is complete, call exit_plan_mode to present it to the user.`
  }
}
