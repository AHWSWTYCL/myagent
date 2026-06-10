/**
 * SessionCommand — session 管理命令
 *
 * 子命令：
 *   /session list          列出所有 session 及元数据
 *   /session stats         显示当前 session 的实时 stats
 *   /session rename <name> 重命名当前 session
 *   /session tag <tag>     设置当前 session 的标签
 */

import { Command } from './command.js'
import { SessionManager } from '../session/SessionManager.js'
import type { SessionSummary } from '../session/SessionManager.js'

function statusIcon(isClosed: boolean): string {
  return isClosed ? '✓' : '●'
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export class SessionCommand extends Command {
  private sessionManager: SessionManager

  constructor() {
    super()
    this.sessionManager = SessionManager.getInstance()
  }

  get name(): string { return 'session' }

  get description(): string {
    return '管理 session：list / stats / rename <name> / tag <tag>'
  }

  get usage(): string {
    return '/session list | /session stats | /session rename <name> | /session tag <tag>'
  }

  async execute(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase()

    switch (sub) {
      case 'list':
      case 'ls':
        return this.cmdList()
      case 'stats':
      case 'st':
        return this.cmdStats()
      case 'rename':
      case 'name':
        return this.cmdRename(args.slice(1))
      case 'tag':
        return this.cmdTag(args.slice(1))
      default:
        console.log(`未知子命令: ${sub || '(空)'}`)
        console.log(`用法: ${this.usage}`)
        console.log('')
        console.log('子命令：')
        console.log('  /session list           列出所有 session')
        console.log('  /session stats          显示当前 session 统计')
        console.log('  /session rename <name>  重命名当前 session')
        console.log('  /session tag <tag>      设置标签')
    }
  }

  private cmdList(): void {
    const sessions = SessionManager.listSessions()
    if (sessions.length === 0) {
      console.log('暂无 session 记录。')
      return
    }

    const currentId = this.sessionManager.getSessionId()

    console.log(`Session 列表（共 ${sessions.length} 个）：\n`)
    for (const s of sessions) {
      const icon = statusIcon(s.isClosed)
      const isCurrent = s.sessionId === currentId
      const marker = isCurrent ? ' ← 当前' : ''

      // 标题：优先用 customTitle，其次 lastPrompt，最后 sessionId
      const title = s.customTitle || s.lastPrompt || s.sessionId
      const displayTitle = title.length > 60 ? title.slice(0, 57) + '…' : title

      const stats = s.stats
        ? `  turns:${s.stats.turns} tools:${s.stats.toolCalls} in:${formatTokens(s.stats.tokensIn)} out:${formatTokens(s.stats.tokensOut)}`
        : ''

      const tagStr = s.tag ? ` [${s.tag}]` : ''
      const statusStr = s.isClosed ? `closed ${s.closedAt?.slice(0, 10) ?? ''}` : 'running'

      console.log(`  ${icon} ${displayTitle}${tagStr}${marker}`)
      console.log(`     ${statusStr}${stats}`)
      console.log('')
    }
  }

  private cmdStats(): void {
    const id = this.sessionManager.getSessionId()
    if (!id) {
      console.log('Session 尚未初始化。')
      return
    }

    const stats = this.sessionManager.getStats()
    const elapsed = Date.now() - stats.startTime
    const title = this.sessionManager.getCustomTitle()
    const tag = this.sessionManager.getTag()

    console.log(`Session: ${id}`)
    if (title) console.log(`标题:    ${title}`)
    if (tag) console.log(`标签:    ${tag}`)
    console.log(`运行时间: ${formatDuration(elapsed)}`)
    console.log('')
    console.log(`Turns:     ${stats.turns}`)
    console.log(`工具调用:  ${stats.toolCalls}`)
    console.log(`Token 输入: ${formatTokens(stats.tokensIn)}`)
    console.log(`Token 输出: ${formatTokens(stats.tokensOut)}`)
    console.log(`压缩次数:  ${stats.compactions}`)
    console.log(`错误次数:  ${stats.errors}`)
  }

  private cmdRename(nameArgs: string[]): void {
    if (nameArgs.length === 0) {
      console.log('用法: /session rename <name>')
      return
    }
    const name = nameArgs.join(' ').trim()
    if (!name) {
      console.log('名称不能为空。')
      return
    }
    this.sessionManager.setCustomTitle(name)
    console.log(`已重命名为: ${name}`)
  }

  private cmdTag(tagArgs: string[]): void {
    if (tagArgs.length === 0) {
      console.log('用法: /session tag <tag>')
      return
    }
    const tag = tagArgs.join(' ').trim()
    if (!tag) {
      console.log('标签不能为空。')
      return
    }
    this.sessionManager.setTag(tag)
    console.log(`标签已设置为: ${tag}`)
  }
}
