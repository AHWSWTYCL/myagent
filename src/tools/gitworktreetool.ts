import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { WorktreeManager } from '../worktree/worktreeManager.js'

export class GitWorktreeTool extends Tool {
  private manager: WorktreeManager
  constructor() { super(); this.manager = WorktreeManager.getInstance() }

  get name(): string { return 'git_worktree' }

  get description(): string {
    return [
      '管理 git worktree，用于并行开发。',
      'create/exit/keep/status: 主 session 的 worktree 管理（会切换 cwd）。',
      'agent_create/agent_remove: sub-agent 用，不切换全局 cwd，只返回/清理 worktree 路径。',
    ].join('\n')
  }

  get inputSchemaZod() {
    return z.object({
      action: z.enum(['create', 'exit', 'keep', 'status', 'agent_create', 'agent_remove'])
        .describe('create/exit/keep/status 用于主会话; agent_create/agent_remove 用于 sub-agent 隔离'),
      name: z.string().optional().describe('worktree 名称'),
      branch: z.string().optional().describe('分支名'),
      force: z.boolean().optional().describe('强制删除'),
      path: z.string().optional().describe('要删除的 worktree 路径（agent_remove 用）'),
    })
  }

  get outputSchemaZod() { return z.string() }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const a = input.action as string; const n = input.name as string | undefined
    if (a === 'create') return { label: 'GitWorktree', args: `create ${n || '(random)'}` }
    if (a === 'agent_create') return { label: 'GitWorktree', args: `agent_create ${n || '(random)'}` }
    if (a === 'exit') return { label: 'GitWorktree', args: `exit${input.force ? ' --force' : ''}` }
    if (a === 'keep') return { label: 'GitWorktree', args: 'keep' }
    if (a === 'agent_remove') return { label: 'GitWorktree', args: 'agent_remove' }
    return { label: 'GitWorktree', args: 'status' }
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> { return { action: 'continue' } }

  async execute(args: { action: string; name?: string; branch?: string; force?: boolean; path?: string }): Promise<string> {
    switch (args.action) {
      case 'create': return this.handleCreate(args.name, args.branch)
      case 'exit': return this.handleExit(args.force)
      case 'keep': return this.handleKeep()
      case 'status': return this.handleStatus()
      case 'agent_create': return this.handleAgentCreate(args.name)
      case 'agent_remove': return this.handleAgentRemove(args.path, args.branch)
      default: return `Unknown action: ${args.action}`
    }
  }

  private handleCreate(name?: string, baseBranch?: string): string {
    const r = this.manager.create(name, baseBranch)
    if (!r.success) return `❌ ${r.error}`
    const tag = r.resumed ? 'resumed' : 'created'
    return `✅ Worktree ${tag}: ${r.name} (${r.branch}) at ${r.path}\nnode_modules symlinked. Use exit or keep when done.`
  }

  private handleExit(force?: boolean): string {
    const r = this.manager.exit(force ?? false)
    if (r.error && !r.hasChanges) return `❌ ${r.error}`
    if (r.removed) return `✅ Worktree removed. Restored to: ${r.restoredCwd}`
    const parts: string[] = []
    if (r.changes.length > 0) parts.push(`${r.changes.length} uncommitted files:\n${r.changes.map(c => `  ${c}`).join('\n')}`)
    if (r.newCommits > 0) parts.push(`${r.newCommits} new commit(s) — removing will DELETE them`)
    return `⚠️ Changes detected:\n${parts.join('\n\n')}\n\nAsk user: keep or delete? KEEP → git_worktree(action="keep"). DELETE → git_worktree(action="exit", force=true).`
  }

  private handleKeep(): string {
    const r = this.manager.keep()
    if (!r.success) return `❌ ${r.error}`
    return `✅ Worktree kept at: ${r.worktreePath}\nRestored to: ${r.restoredCwd}`
  }

  private handleStatus(): string {
    const s = this.manager.getStatus()
    if (!s) return 'No active worktree.'
    const c = this.manager.checkChanges()
    return `📂 ${s.worktreeName} (${s.branch}) at ${s.worktreePath}\n   Status: ${c.changes.length} dirty, ${c.newCommits} new commits`
  }

  // sub-agent: 创建隔离 worktree，不改变全局 cwd
  private handleAgentCreate(name?: string): string {
    const r = this.manager.createSubAgentWorktree(name)
    if (!r.success) return `❌ ${r.error}`
    return `✅ Agent worktree created: ${r.path} (${r.branch})\nUse this path as your working directory. Call agent_remove when done.`
  }

  // sub-agent: 删除隔离 worktree
  private handleAgentRemove(path?: string, branch?: string): string {
    if (!path) return '❌ path is required for agent_remove'
    const ok = this.manager.removeSubAgentWorktree(path, branch)
    return ok ? `✅ Agent worktree removed: ${path}` : `❌ Failed to remove: ${path}`
  }
}
