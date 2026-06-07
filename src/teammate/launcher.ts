/**
 * launcher.ts — 独立进程 teammate 的启动器。
 *
 * 支持两种启动模式：
 *   - warp: 在 Warp 终端新 pane 中启动（macOS）
 *   - process: 通过 child_process 后台启动（跨平台）
 *
 * 设计原则：
 *   - Warp 只是 UI 容器，核心通信仍走 Mailbox
 *   - 启动失败时自动 fallback 到打印手动命令
 *   - AppleScript 优先，URL scheme 作为备选
 */

import * as cp from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import type { TeammateCliOptions } from './teammateRuntime.js'

// ── 启动结果 ────────────────────────────────────────────────────────

export interface LaunchResult {
  mode: 'warp' | 'process' | 'manual'
  agentId: string
  pid?: number
  command: string
  success: boolean
  error?: string
}

// ── Launcher 接口 ───────────────────────────────────────────────────

export interface TeammateLauncher {
  launch(opts: TeammateCliOptions): Promise<LaunchResult>
}

// ── 命令构造 ────────────────────────────────────────────────────────

/**
 * 构造 teammate 启动命令。
 *
 * 策略：
 *   1. 优先使用 npm run agent -- teammate（开发模式）
 *   2. 若 dist/agent.js 存在则用 node dist/agent.js teammate（生产模式）
 */
function buildLaunchCommand(opts: TeammateCliOptions): string {
  const cwd = process.cwd()
  const flags = [
    `--id "${opts.agentId}"`,
    `--leader "${opts.leaderId}"`,
    `--role "${opts.role}"`,
    `--tools "${opts.tools}"`,
  ]
  if (opts.teamName) flags.push(`--team "${opts.teamName}"`)
  if (opts.peers) flags.push(`--peers "${opts.peers}"`)

  const runtime = `npm run agent -- teammate ${flags.join(' ')}`

  return `cd "${cwd}" && ${runtime}`
}

// ── Warp 检测 ────────────────────────────────────────────────────────

function isMacOS(): boolean {
  return os.platform() === 'darwin'
}

function isWarpInstalled(): boolean {
  if (!isMacOS()) return false
  return fs.existsSync('/Applications/Warp.app')
}

// ── Warp AppleScript 启动 ────────────────────────────────────────────

/**
 * 尝试通过 AppleScript 在 Warp 中打开新 pane 并执行命令。
 *
 * Warp 快捷键：
 *   Cmd+D  → 垂直分割（左右 pane）
 *   Cmd+Shift+D → 水平分割（上下 pane）— 我们使用这个
 *
 * 步骤：
 *   1. 激活 Warp
 *   2. 发送 Cmd+Shift+D 创建新 pane
 *   3. 输入命令
 *   4. 按 Enter 执行
 */
async function launchWarpPane(command: string): Promise<{ success: boolean; error?: string }> {
  // AppleScript: 激活 Warp → split pane → 输入命令 → 执行
  const script = `
tell application "Warp"
  activate
end tell

-- 等待 Warp 激活
delay 0.3

tell application "System Events"
  tell process "Warp"
    set frontmost to true

    -- Cmd+Shift+D 创建新分屏 pane
    keystroke "d" using {command down, shift down}
    delay 0.5

    -- 输入命令
    keystroke "${command.replace(/"/g, '\\"')}"
    delay 0.2

    -- 按 Enter 执行
    keystroke return
  end tell
end tell
`

  return new Promise(resolve => {
    cp.execFile('osascript', ['-e', script], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          success: false,
          error: `AppleScript failed: ${stderr?.trim() || err.message}`,
        })
      } else {
        resolve({ success: true })
      }
    })
  })
}

/**
 * 尝试通过 Warp URL scheme 打开（预留）。
 *
 * Warp 文档提到了 "Warp URI scheme"，但具体 API 需要确认。
 * 已知可能的 scheme: warp://, warpterm://
 * 如果未来 Warp 支持 `warp://split?cmd=...` 类似的 API，在这里接入。
 */
async function launchWarpUrlScheme(_command: string): Promise<{ success: boolean; error?: string }> {
  // 预留：等 Warp 公开 URI scheme 文档后实现
  return { success: false, error: 'Warp URL scheme not yet implemented (API docs TBD)' }
}

// ── Child Process 启动 ──────────────────────────────────────────────

/**
 * 通过 child_process.spawn 在后台启动 teammate 进程。
 * 跨平台，不依赖终端。
 */
function launchAsChildProcess(command: string): { pid: number } {
  // 用 bash -c 执行完整命令
  const child = cp.spawn('bash', ['-c', command], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  })

  child.unref() // 不阻止父进程退出

  return { pid: child.pid! }
}

// ── WarpTeammateLauncher ─────────────────────────────────────────────

export class WarpTeammateLauncher implements TeammateLauncher {
  /**
   * 启动策略（按优先级）：
   *   1. Warp AppleScript（新 pane + 执行命令）
   *   2. Child process（后台，无可见窗口）
   *   3. 打印手动命令（最终 fallback）
   */
  async launch(opts: TeammateCliOptions): Promise<LaunchResult> {
    const command = buildLaunchCommand(opts)

    // ── 策略 1: Warp AppleScript ────────────────────────────────
    if (isMacOS() && isWarpInstalled()) {
      const result = await launchWarpPane(command)
      if (result.success) {
        return {
          mode: 'warp',
          agentId: opts.agentId,
          command,
          success: true,
          // Warp pane 中的进程 pid 我们拿不到，但 teammate CLI 会自己写 pid 文件
        }
      }
      // AppleScript 失败，尝试 URL scheme
      const urlResult = await launchWarpUrlScheme(command)
      if (urlResult.success) {
        return {
          mode: 'warp',
          agentId: opts.agentId,
          command,
          success: true,
        }
      }
      // 两个都失败了，打印警告但继续尝试 child process
      console.error(`[launcher] Warp automation failed, falling back to child process: ${result.error}`)
    }

    // ── 策略 2: Child Process ──────────────────────────────────
    try {
      const { pid } = launchAsChildProcess(command)
      return {
        mode: 'process',
        agentId: opts.agentId,
        pid,
        command,
        success: true,
      }
    } catch (err) {
      console.error(`[launcher] Child process failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // ── 策略 3: 手动命令 ───────────────────────────────────────
    return {
      mode: 'manual',
      agentId: opts.agentId,
      command,
      success: true,
      error: 'Please run manually in a new Warp pane',
    }
  }
}

// ── 便捷工厂 ─────────────────────────────────────────────────────────

/**
 * 创建默认的 teammate 启动器。
 *
 * macOS + Warp → WarpTeammateLauncher (new pane)
 * 其他平台 → ChildProcessLauncher (后台进程)
 */
export function createLauncher(): TeammateLauncher {
  return new WarpTeammateLauncher()
}

/**
 * 格式化 LaunchResult 为可读字符串（给 leader LLM 看）。
 */
export function formatLaunchResult(result: LaunchResult): string {
  const lines: string[] = []

  const modeLabel = {
    warp: 'Warp pane',
    process: 'background process',
    manual: 'manual (run command below)',
  }[result.mode]

  lines.push(`Teammate "${result.agentId}" launched via ${modeLabel}.`)

  if (result.pid) {
    lines.push(`PID: ${result.pid}`)
  }

  if (result.mode === 'manual') {
    lines.push('')
    lines.push('Run this command in a new Warp pane:')
    lines.push('')
    lines.push(`  ${result.command}`)
  }

  if (result.error) {
    lines.push(`Note: ${result.error}`)
  }

  return lines.join('\n')
}
