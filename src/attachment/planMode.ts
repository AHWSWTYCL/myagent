import { Attachment } from './attachment.js'

/**
 * PlanModeAttachment — 进入 plan mode 时注入的行为约束 prompt。
 *
 * 设计：
 * - 在 plan mode 期间，通过 AttachmentQueue 注入行为约束。
 * - 每 5 次 query 注入完整版（约 20 行），其余 query 注入简短提醒（1 行），节约 token。
 * - 退出 plan mode 时不清除 attachment（由 turn.ts 控制注入节奏）。
 */
export class PlanModeAttachment extends Attachment {
  /** 当前是完整版还是简短版 */
  private fullVersion: boolean

  constructor(fullVersion: boolean) {
    super('PlanModeAttachment')
    this.fullVersion = fullVersion
  }

  get type(): string {
    return 'plan_mode'
  }

  get summary(): string {
    return this.fullVersion
      ? 'Plan mode active — exploration & planning only'
      : 'Plan mode reminder'
  }

  get content(): string {
    if (this.fullVersion) {
      return `[Plan Mode — Full Instructions]

你当前处于 **Plan Mode（计划模式）**。在此模式下，你必须遵守以下规则：

1. **只探索和计划**：你只能使用只读工具（read_file, list_dir, grep, glob, web_search, web_fetch）来探索代码和研究问题。

2. **不能修改代码**：禁止使用 write_file, edit_file, bash 等会修改文件或系统状态的工具。如果你尝试使用这些工具，系统会自动拒绝。

3. **计划在回复中呈现**：你的计划应该直接在 Markdown 回复中编写，不需要调用任何写入工具。用户可以阅读你的回复来判断是否接受计划。

4. **计划结构建议**：
   - 问题/需求描述
   - 可行性分析（引用的现有代码和关键接口）
   - 推荐方案（含架构图/ASCII art）
   - 实施步骤（分阶段、带依赖关系）
   - 风险点和注意事项

5. **退出计划模式**：当你完成计划后，调用 exit_plan_mode 工具。系统会询问用户是否接受计划，接受后会自动退出计划模式并恢复到之前的模式。`
    }

    return `[Plan Mode] 你处于计划模式 — 只能探索和计划，不能修改代码。完成后调用 exit_plan_mode 退出。`
  }
}
