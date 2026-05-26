import * as fs from 'fs'
import * as path from 'path'
import { Hook, HookContext, HookResult } from './hook.js'
import type { TuiBridge } from '../tui/bridge.js'
import type { EditDiffResult } from '../tools/edittool.js'

const LOG_PATH = path.join(process.cwd(), '.myagent', 'agent.log')

function ts(): string {
  const d = new Date()
  return d.toISOString().replace('T', ' ').replace('Z', '')
}

function appendLog(line: string): void {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, line.endsWith('\n') ? line : line + '\n', 'utf-8')
  } catch {
    // logging is best-effort; never crash the agent over a log write
  }
}

/**
 * Records every tool call to .claude/agent.log and forwards structured edit
 * diffs to the TUI. All other on-screen tool reporting goes through
 * ToolCallView (Claude Code style entries), so we never push tool messages
 * into the chat from here.
 */
export class LoggerHook implements Hook {
  name = 'LoggerHook'

  constructor(private bridge: TuiBridge) {}

  async onToolCall(ctx: HookContext): Promise<HookResult> {
    const args = JSON.stringify(ctx.toolInput ?? {})
    appendLog(`[${ts()}] CALL  ${ctx.toolName}  ${args.slice(0, 2000)}`)
    return { action: 'continue' }
  }

  async onToolResult(ctx: HookContext): Promise<void> {
    const result = ctx.toolResult ?? ''
    const preview = result.length > 4000 ? result.slice(0, 4000) + ' …(truncated)' : result
    appendLog(`[${ts()}] DONE  ${ctx.toolName}  ${preview.replace(/\n/g, '\\n')}`)

    if (ctx.toolName !== 'edit_file') return
    try {
      const parsed = JSON.parse(result) as { summary: string; diff: EditDiffResult }
      if (parsed.diff?.lines) {
        this.bridge.emitEditDiff(parsed.diff.filePath, parsed.diff.lines, parsed.diff.additions, parsed.diff.removals)
      }
    } catch {
      // not JSON — nothing structured to render
    }
  }
}
