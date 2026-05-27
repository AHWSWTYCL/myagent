import { spawn } from 'child_process'
import { cwd } from 'process'
import { Tool, type ToolRenderHeader } from './tool'

const TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 50_000
const KILL_GRACE_MS = 2_000  // SIGTERM 后 2 秒再 SIGKILL

// 每条规则：pattern 用于匹配命令，reason 用于错误提示
const BLACKLIST: { pattern: RegExp; reason: string }[] = [
    // 递归强制删除
    { pattern: /rm\s+.*-[a-z]*r[a-z]*f|rm\s+.*-[a-z]*f[a-z]*r/i, reason: 'recursive force delete (rm -rf) is not allowed' },
    // 删除根目录 / 或 /*
    { pattern: /rm\s+.*[\s'"`]\/['"`]?\s*$|rm\s+.*[\s'"`]\/\*/i, reason: 'deleting root directory is not allowed' },
    // 格式化磁盘
    { pattern: /mkfs\b/i, reason: 'disk formatting (mkfs) is not allowed' },
    // 写入磁盘设备
    { pattern: /dd\s+.*of=\/dev\/(sd|hd|nvme|disk)/i, reason: 'writing to raw disk device is not allowed' },
    // 清空系统关键目录
    { pattern: />\s*\/etc\/(passwd|shadow|hosts|sudoers)/i, reason: 'overwriting system files is not allowed' },
    // fork bomb
    { pattern: /:\(\)\s*\{.*:\|:.*\}/i, reason: 'fork bomb is not allowed' },
    // 关机 / 重启
    { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'system shutdown/reboot is not allowed' },
    // 修改文件权限为全局可写（chmod 777 敏感路径）
    { pattern: /chmod\s+.*777\s+\//i, reason: 'chmod 777 on root paths is not allowed' },
    // 通过 curl/wget 直接 pipe 到 shell 执行
    { pattern: /(curl|wget)\s+.*\|\s*(ba)?sh/i, reason: 'piping remote scripts to shell is not allowed' },
]

// 只读命令前缀——检查到这些命令直接允许，不触发权限链
const READONLY_PREFIXES = [
    'ls', 'cat', 'head', 'tail', 'less', 'more', 'echo',
    'pwd', 'which', 'type', 'where',
    'git status', 'git log', 'git diff', 'git show', 'git branch', 'git stash list',
    'git config', 'git remote', 'git ls-files', 'git ls-tree',
    'npm ls', 'npm list', 'pnpm ls', 'pnpm list', 'yarn why',
    'find ', 'wc ', 'sort ', 'uniq ', 'od ', 'xxd ', 'hexdump',
]

function isReadonlyCommand(command: string): boolean {
    const trimmed = command.trim()
    for (const prefix of READONLY_PREFIXES) {
        if (trimmed === prefix || trimmed.startsWith(prefix + ' ')) {
            return true
        }
    }
    return false
}

/** 异步执行 bash 命令，返回 stdout（合并 stderr 仅在命令失败时）。 */
function runBashAsync(
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,  // 创建新进程组，确保 kill 能传播到所有子进程
    })

    let stdout = ''
    let stderr = ''
    let truncatedBytes = 0

    const appendStdout = (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        const room = MAX_OUTPUT_BYTES - stdout.length
        stdout += chunk.slice(0, room)
        truncatedBytes += Math.max(0, chunk.length - room)
      } else {
        truncatedBytes += chunk.length
      }
    }
    const appendStderr = (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        const room = MAX_OUTPUT_BYTES - stderr.length
        stderr += chunk.slice(0, room)
      }
      // stderr 不计入 truncation 统计（避免和 stdout 的统计混淆）
    }

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', appendStdout)
    child.stderr.on('data', appendStderr)

    let timedOut = false
    let aborted = false
    let killTimer: NodeJS.Timeout | null = null

    const killProcessGroup = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig) } catch { /* already dead */ }
    }

    const timeout = setTimeout(() => {
      timedOut = true
      killProcessGroup('SIGTERM')
      killTimer = setTimeout(() => {
        killProcessGroup('SIGKILL')
      }, KILL_GRACE_MS)
    }, TIMEOUT_MS)

    // ── AbortSignal 支持：用户按 Esc 时杀掉整个进程组 ──────────
    const onAbort = () => {
      aborted = true
      clearTimeout(timeout)
      killProcessGroup('SIGTERM')
      killTimer = setTimeout(() => {
        killProcessGroup('SIGKILL')
      }, KILL_GRACE_MS)
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.on('error', (err) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(`Error spawning bash: ${err.message}\nCommand: ${command}`)
    })

    child.on('close', (code, sig) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      if (signal) signal.removeEventListener('abort', onAbort)

      const bytesNote = truncatedBytes > 0
        ? `\n...（${truncatedBytes} 字节因超出 ${MAX_OUTPUT_BYTES} 上限被丢弃）`
        : ''

      if (aborted) {
        resolve(`Cancelled by user.\n${stdout || '(no output)'}${bytesNote}`)
        return
      }
      if (timedOut) {
        const combined = [stdout, stderr].filter(Boolean).join('\n')
        resolve(`Timed out after ${TIMEOUT_MS / 1000}s (signal=${sig ?? 'SIGTERM'}):\n${combined || '(no output)'}${bytesNote}`)
        return
      }
      if (code === 0) {
        resolve(stdout || '(no output)')
        return
      }
      // 非零退出码：合并 stdout + stderr 输出
      const combined = [stdout, stderr].filter(Boolean).join('\n')
      resolve(`Exit code ${code ?? '?'}${sig ? ` (signal ${sig})` : ''}:\n${combined || '(no output)'}${bytesNote}`)
    })
  })
}

export class BashTool extends Tool {

    get name(): string {
        return 'bash'
    }

    get description(): string {
        return 'Execute a bash command in the current working directory and return its output. Avoid long-running or interactive commands.'
    }

    get input_schema(): { type: 'object'; properties: object; required: string[] } {
        return {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The bash command to execute' },
            },
            required: ['command'],
        }
    }

    renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
        return { label: 'Bash', args: Tool.truncate(String(input.command ?? ''), 120) }
    }

    renderToolResult(output: string, isError: boolean): string[] {
        return Tool.summarize(output, isError)
    }

    private checkBlacklist(command: string): string | null {
        for (const { pattern, reason } of BLACKLIST) {
            if (pattern.test(command)) {
                return reason
            }
        }
        return null
    }

    async checkPermission(args: Record<string, unknown>): Promise<import('./tool.js').ToolPermissionResult> {
        const command = (args.command ?? '') as string
        if (!command.trim()) return { action: 'defer' }

        // 只读命令 → 安全，直接放行
        if (isReadonlyCommand(command)) {
            return { action: 'continue' }
        }

        // 黑名单命令 → 阻断
        const blocked = this.checkBlacklist(command)
        if (blocked) {
            return { action: 'block', reason: blocked }
        }

        // 其他写操作 → 交给上层决定
        return { action: 'defer' }
    }

    async execute(args: any, signal?: AbortSignal): Promise<string> {
        const command: string = args.command

        const blocked = this.checkBlacklist(command)
        if (blocked) {
            return `[BLOCKED] Command rejected: ${blocked}\nCommand: ${command}`
        }

        return runBashAsync(command, signal)
    }
}
