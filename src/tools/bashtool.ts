import { execSync } from 'child_process'
import { cwd } from 'process'
import { Tool } from './tool'

const TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 50_000

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

    private checkBlacklist(command: string): string | null {
        for (const { pattern, reason } of BLACKLIST) {
            if (pattern.test(command)) {
                return reason
            }
        }
        return null
    }

    async execute(args: any): Promise<string> {
        const command: string = args.command

        const blocked = this.checkBlacklist(command)
        if (blocked) {
            return `[BLOCKED] Command rejected: ${blocked}\nCommand: ${command}`
        }

        try {
            const output = execSync(command, {
                cwd: cwd(),
                timeout: TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            })
            return output || '(no output)'
        } catch (err: any) {
            const stdout = err.stdout ?? ''
            const stderr = err.stderr ?? ''
            const combined = [stdout, stderr].filter(Boolean).join('\n')
            return `Exit code ${err.status ?? '?'}:\n${combined || err.message}`
        }
    }
}
