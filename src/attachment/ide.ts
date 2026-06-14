import { Attachment } from './attachment.js'

/**
 * VSCode 诊断信息 Attachment。
 * 对齐 Claude Code 的 diagnostics attachment，将诊断变更以结构化方式注入上下文。
 */
export class IDEDiagnosticsAttachment extends Attachment {
  readonly type = 'ide_diagnostics'

  constructor(
    public readonly rawJson: string,
  ) {
    super('vscode-mcp')
  }

  get summary(): string {
    try {
      const parsed = JSON.parse(this.rawJson)
      const s = parsed.summary
      const parts: string[] = []
      if (s.errors) parts.push(`${s.errors} errors`)
      if (s.warnings) parts.push(`${s.warnings} warnings`)
      if (s.hints) parts.push(`${s.hints} hints`)
      return `VSCode: ${parts.join(', ') || 'no issues'}`
    } catch {
      return 'VSCode diagnostics updated'
    }
  }

  get content(): string {
    return this.rawJson
  }
}

/**
 * IDE 选中内容 Attachment。
 * 对齐 Claude Code 的 selected_lines_in_ide attachment。
 * 用户在 VSCode 中选中的代码片段。
 */
export class IDESelectionAttachment extends Attachment {
  readonly type = 'ide_selection'

  constructor(
    public readonly filePath: string,
    public readonly startLine: number,
    public readonly endLine: number,
    public readonly text: string,
  ) {
    super('vscode-mcp')
  }

  get summary(): string {
    const display = this.filePath.split('/').pop() || this.filePath
    const range = this.startLine === this.endLine
      ? `line ${this.startLine}`
      : `lines ${this.startLine}-${this.endLine}`
    return `Selected ${range} from ${display}`
  }

  get content(): string {
    const range = this.startLine === this.endLine
      ? `line ${this.startLine}`
      : `lines ${this.startLine} to ${this.endLine}`
    return `The user selected ${range} from ${this.filePath}:\n${this.text}`
  }
}
