import { spawn } from 'child_process'
import { cwd } from 'process'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool'

// Defaults can be overridden via env to support long-running builds/tests.
function readPositiveInt(envName: string, fallback: number): number {
  const raw = process.env[envName]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const TIMEOUT_MS = readPositiveInt('MYAGENT_BASH_TIMEOUT_MS', 10_000)
const MAX_OUTPUT_BYTES = readPositiveInt('MYAGENT_BASH_MAX_OUTPUT_BYTES', 50_000)
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
    'du ', 'df ', 'stat ', 'file ',
    'env', 'printenv',
    'gh auth status', 'gh auth token',
    'git status', 'git log', 'git diff', 'git show', 'git branch', 'git stash list',
    'git stash show', 'git diff --staged', 'git diff --cached',
    'git config', 'git remote', 'git ls-files', 'git ls-tree',
    'npm ls', 'npm list', 'pnpm ls', 'pnpm list', 'yarn why',
    'find ', 'wc ', 'sort ', 'uniq ', 'od ', 'xxd ', 'hexdump',
    'rg ', 'ag ', 'ack ',
]

// 安全写命令前缀——不会造成系统级破坏，放行不弹确认。
// 这些命令会影响当前项目目录，但不属于危险操作，auto 模式下不应反复询问。
const SAFE_WRITE_PREFIXES = [
    // 文件/目录操作
    'mkdir ', 'mkdir -p', 'cp ', 'mv ', 'touch ',
    'rm ', 'rmdir ', 'rm -rf',  // rm -rf / 已被黑名单拦截
    'chmod ', 'chown ',
    'ln -s', 'ln ',
    'unzip ', 'unxz ', 'unlzma ', 'gunzip ', 'bunzip2 ', 'tar ',
    // 包管理
    'npm install', 'npm i ', 'npm run', 'npm update', 'npm uninstall',
    'npm create', 'npm publish', 'npm version',
    'pnpm install', 'pnpm i ', 'pnpm run', 'pnpm update', 'pnpm uninstall',
    'pnpm create', 'pnpm publish',
    'yarn add', 'yarn remove', 'yarn install', 'yarn run',
    'yarn create', 'yarn publish',
    'bun install', 'bun add', 'bun run', 'bun create',
    'npx ',
    'pip install', 'pip uninstall', 'pip3 install', 'pip3 uninstall',
    'pipenv install', 'pipenv run',
    'poetry add', 'poetry install', 'poetry run',
    'uv pip install', 'uv add', 'uv run', 'uv build',
    'cargo build', 'cargo run', 'cargo test', 'cargo check', 'cargo add',
    'cargo install', 'cargo publish', 'cargo update',
    'go build', 'go run', 'go test', 'go mod', 'go install', 'go get',
    'rustup',
    'make', 'cmake', 'cmake --build', 'cmake --install',
    // gh CLI（GitHub 操作，需 gh auth login 认证）
    'gh auth', 'gh api', 'gh repo', 'gh issue', 'gh pr',
    'gh release', 'gh run', 'gh workflow', 'gh secret', 'gh variable',
    'gh search', 'gh gist', 'gh label', 'gh project',
    // git 写操作
    'git add', 'git commit', 'git push', 'git pull', 'git merge',
    'git checkout', 'git switch', 'git reset', 'git revert',
    'git stash', 'git tag', 'git fetch', 'git rm', 'git rebase',
    'git cherry-pick', 'git submodule',
    'git init', 'git clone', 'git clean',
    // 构建工具
    'tsc', 'tsc --', 'esbuild', 'vite build', 'webpack', 'rollup',
    'node ', 'deno ', 'python ', 'python3 ',
    // docker（用于本地开发）
    'docker build', 'docker compose', 'docker-compose',
    'docker run --rm', 'docker pull',
    // 下载文件
    'curl -o', 'curl -O', 'curl --output', 'wget ',
    // macOS 包管理
    'brew install', 'brew uninstall', 'brew upgrade', 'brew update',
    'brew link', 'brew unlink', 'brew services',
    // 重定向/追加（明确的写文件）
    'cat >', 'cat >>',
    'echo >', 'echo >>',
]

function isReadonlyCommand(command: string): boolean {
    const trimmed = command.trim()
    // Reject anything with shell composition. `ls && rm -rf x` or `cat a | sh`
    // would otherwise match the prefix list and bypass the prompt. Backticks
    // and $(...) are also rejected since they execute arbitrary subcommands.
    if (/[;&|`]/.test(trimmed)) return false
    if (/\$\(/.test(trimmed)) return false
    // Output redirection writes to disk — not read-only.
    if (/(^|[^<])>/.test(trimmed)) return false
    for (const prefix of READONLY_PREFIXES) {
        if (trimmed === prefix || trimmed.startsWith(prefix + ' ')) {
            return true
        }
    }
    return false
}

/** 判断是否为安全写命令（不会造成系统级破坏，auto 模式下直接放行）。 */
function isSafeWriteCommand(command: string): boolean {
    const trimmed = command.trim()
    // 管道/组合/反引号 → 无法简单判断安全，交给 defer
    if (/[;&|`]/.test(trimmed)) return false
    if (/\$\(/.test(trimmed)) return false
    for (const prefix of SAFE_WRITE_PREFIXES) {
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
        const timeoutSec = Math.round(TIMEOUT_MS / 1000)
        const outputKB = Math.round(MAX_OUTPUT_BYTES / 1024)
        return [
            'Execute a bash command in the current working directory and return its output.',
            `Hard limits: ${timeoutSec}s wall-clock timeout (process group killed on overrun); stdout truncated past ${outputKB} KB (truncation is reported in the output suffix).`,
            'Avoid interactive commands (no stdin available). For long-running builds or test suites, raise MYAGENT_BASH_TIMEOUT_MS in the environment instead of running them here.',
        ].join(' ')
    }

    get inputSchemaZod() {
        return z.object({
            command: z.string().describe('The bash command to execute'),
        })
    }

    get outputSchemaZod() {
        return z.string()
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

        // 安全写命令 → 放行（如 npm install, mkdir, git add 等）
        if (isSafeWriteCommand(command)) {
            return { action: 'continue' }
        }

        // 其他不确定的操作 → 交给上层决定
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
