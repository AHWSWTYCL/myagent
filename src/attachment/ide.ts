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

/**
 * 扩展控制台日志 Attachment。
 * 对齐 Claude Code 的 bagel_console attachment。
 * 捕获 VSCode 扩展运行时 console.error/warn 输出。
 */
export class ExtensionConsoleAttachment extends Attachment {
  readonly type = 'extension_console'

  constructor(
    public readonly rawJson: string,
  ) {
    super('vscode-mcp')
  }

  get summary(): string {
    try {
      const parsed = JSON.parse(this.rawJson)
      const count = parsed.count ?? parsed.entries?.length ?? 0
      if (count === 0) return 'Extension console: no errors'
      const errors = parsed.entries?.filter((e: { level: string }) => e.level === 'error').length ?? 0
      const warns = parsed.entries?.filter((e: { level: string }) => e.level === 'warn').length ?? 0
      const parts: string[] = []
      if (errors > 0) parts.push(`${errors} errors`)
      if (warns > 0) parts.push(`${warns} warns`)
      return `Extension console: ${parts.join(', ') || `${count} entries`}`
    } catch {
      return 'Extension console logs updated'
    }
  }

  get content(): string {
    try {
      const parsed = JSON.parse(this.rawJson)
      const entries = parsed.entries as Array<{ level: string; message: string; ts: number }> | undefined
      if (!entries || entries.length === 0) return 'No extension console logs.'
      const lines = entries.map(e =>
        `[${e.level.toUpperCase()}] ${new Date(e.ts).toISOString()} ${e.message}`,
      )
      return `[Extension Console Logs — ${entries.length} entries]\n${lines.join('\n')}`
    } catch {
      return this.rawJson
    }
  }
}

// ── IDE 状态收集器 ────────────────────────────────────────────────────────────

/**
 * IDE 状态提供者接口。
 * 由 mcpManager 实现，供 collectIDEAttachments 调用。
 * 最小接口：只暴露三个 getAndClear 方法，避免循环依赖。
 */
export interface IDEStateProvider {
  getVSCodeDiagnosticsAndClear(): string | null
  getIDESelectionAndClear(): {
    text: string
    filePath: string
    startLine: number
    endLine: number
  } | null
  getExtensionLogsAndClear(): string | null
}

/**
 * 从 IDE 状态提供者拉取最新状态并 enqueue 到 AttachmentQueue。
 * 在 fetchVSCodeDiagnostics 完成后调用，将 IDE 相关 Attachment 推入队列。
 * 这样 turn.ts 的 drainAttachments 回调只需 formatDrain()，不再需要直接
 * 依赖 IDE 相关 Attachment 类型。
 */
export function collectIDEAttachments(
  provider: IDEStateProvider,
  queue: { enqueue(att: Attachment): void },
): void {
  const diags = provider.getVSCodeDiagnosticsAndClear()
  if (diags) {
    queue.enqueue(new IDEDiagnosticsAttachment(diags))
  }

  const sel = provider.getIDESelectionAndClear()
  if (sel) {
    queue.enqueue(new IDESelectionAttachment(
      sel.filePath,
      sel.startLine,
      sel.endLine,
      sel.text,
    ))
  }

  const logs = provider.getExtensionLogsAndClear()
  if (logs) {
    queue.enqueue(new ExtensionConsoleAttachment(logs))
  }
}
