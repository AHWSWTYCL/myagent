/**
 * BgCommand — 后台任务管理命令
 *
 * 子命令：
 *   /bg list          — 列出所有后台任务（运行中 + 已完成）
 *   /bg show <id>     — 查看指定后台任务的输出文件
 *   /bg kill <id>     — 中止一个运行中的后台任务
 *
 * 实现模式：复用 Command 基类，通过 console.log 输出（TUI 模式下被 bridge 捕获）。
 */

import fs from 'fs'
import path from 'path'
import { Command } from './command.js'
import { bgManager } from '../utils/backgroundManager.js'

const BG_DIR = path.join(process.cwd(), '.myagent', 'background')

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function formatDuration(start: number, end?: number): string {
  const elapsed = Math.floor(((end ?? Date.now()) - start) / 1000)
  if (elapsed < 60) return `${elapsed} 秒`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
  const h = Math.floor(elapsed / 3600)
  const m = Math.floor((elapsed % 3600) / 60)
  return `${h} 时 ${m} 分`
}

function statusIcon(status: string): string {
  switch (status) {
    case 'running': return '●'
    case 'completed': return '✓'
    case 'failed': return '✗'
    case 'killed': return '⊘'
    default: return '?'
  }
}

export class BgCommand extends Command {
  get name(): string {
    return 'bg'
  }

  get description(): string {
    return '管理后台任务：list / show <id> / kill <id>'
  }

  get usage(): string {
    return '/bg list | /bg show <id> | /bg kill <id>'
  }

  async execute(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase()

    switch (sub) {
      case 'list':
      case 'ls':
        return this.cmdList()
      case 'show':
      case 'cat':
        return this.cmdShow(args.slice(1))
      case 'kill':
      case 'stop':
        return this.cmdKill(args.slice(1))
      default:
        console.log(`未知子命令: ${sub || '(空)'}`)
        console.log(`用法: ${this.usage}`)
        console.log('')
        console.log('子命令：')
        console.log('  /bg list          列出所有后台任务')
        console.log('  /bg show <id>     查看后台任务输出')
        console.log('  /bg kill <id>     中止运行中的后台任务')
    }
  }

  /** /bg list — 列出所有后台任务 */
  private cmdList(): void {
    const tasks = bgManager.list()
    if (tasks.length === 0) {
      console.log('暂无后台任务。按 Ctrl+B 可将当前任务转入后台运行。')
      return
    }

    console.log(`后台任务（共 ${tasks.length} 个）：\n`)
    for (const t of tasks) {
      const icon = statusIcon(t.status)
      const desc = t.description.length > 60
        ? t.description.slice(0, 57) + '…'
        : t.description
      switch (t.status) {
        case 'running':
          console.log(`  ${icon}  ${t.id}  running   "${desc}"  已运行 ${formatDuration(t.startTime)}`)
          break
        case 'completed':
          console.log(`  ${icon}  ${t.id}  done      "${desc}"  完成于 ${formatTime(t.endTime!)}`)
          break
        case 'failed':
          console.log(`  ${icon}  ${t.id}  failed    "${desc}"  ${t.error ? `错误: ${t.error}` : ''}`)
          break
        case 'killed':
          console.log(`  ${icon}  ${t.id}  killed    "${desc}"  中止于 ${formatTime(t.endTime!)}`)
          break
      }
    }
  }

  /** /bg show <id> — 查看后台任务输出文件 */
  private cmdShow(idArgs: string[]): void {
    if (idArgs.length === 0) {
      console.log('用法: /bg show <task-id>')
      return
    }
    const taskId = idArgs[0]

    // 先查 manager（运行中或已完成的任务）
    const info = bgManager.get(taskId)
    if (info) {
      console.log(`任务: ${info.id}`)
      console.log(`描述: ${info.description}`)
      console.log(`状态: ${statusIcon(info.status)} ${info.status}`)
      if (info.endTime) console.log(`完成于: ${new Date(info.endTime).toISOString()}`)
      if (info.outputPath) console.log(`输出文件: ${info.outputPath}`)
      if (info.error) console.log(`错误: ${info.error}`)
      console.log('')
    }

    // 读取文件（无论是否在 manager 中，都尝试打开文件）
    const filePath = path.join(BG_DIR, `${taskId}.md`)
    if (!fs.existsSync(filePath)) {
      if (!info) {
        console.log(`未找到后台任务: ${taskId}`)
        console.log(`使用 /bg list 查看所有任务。`)
      }
      return
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    // 如果内容很大，截断到 2000 字符避免刷屏
    const lines = content.split('\n')
    if (lines.length > 60 || content.length > 2000) {
      const truncated = lines.slice(0, 50).join('\n')
      console.log(`\n--- 输出（前 50 行 / ${lines.length} 行）---`)
      console.log(truncated)
      if (lines.length > 50) {
        console.log(`...（剩余 ${lines.length - 50} 行，直接打开文件查看全文）`)
      }
    } else {
      console.log(`\n--- 输出 ---`)
      console.log(content)
    }
  }

  /** /bg kill <id> — 中止运行中的后台任务 */
  private cmdKill(idArgs: string[]): void {
    if (idArgs.length === 0) {
      console.log('用法: /bg kill <task-id>')
      return
    }
    const taskId = idArgs[0]
    const info = bgManager.get(taskId)
    if (!info) {
      console.log(`未找到后台任务: ${taskId}`)
      return
    }
    if (info.status !== 'running') {
      console.log(`任务 ${taskId} 状态为 ${info.status}，无法中止。`)
      return
    }
    const ok = bgManager.kill(taskId)
    if (ok) {
      console.log(`已中止后台任务: ${taskId} ("${info.description}")`)
    }
  }
}
