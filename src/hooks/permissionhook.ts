import { Hook, HookContext, HookResult } from './hook.js'

export type PermissionAnswer = 'yes' | 'session' | 'no'

export class PermissionHook implements Hook {
  name = 'PermissionHook'

  /** 会话级别自动放行的 key 集合 */
  private sessionAllowed: Set<string> = new Set()

  constructor(private askPermission: (prompt: string) => Promise<PermissionAnswer>) {}

  async onToolCall(ctx: HookContext): Promise<HookResult> {
    const dangerousTools = ['write_file', 'bash']
    if (!dangerousTools.includes(ctx.toolName)) {
      return { action: 'continue' }
    }

    const args = ctx.toolInput as Record<string, string>
    const key = ctx.toolName === 'bash' ? `bash:${args.command}` : `write_file:${args.path}`

    // 会话已允许 → 自动放行
    if (this.sessionAllowed.has(key)) {
      return { action: 'continue' }
    }

    const prompt =
      ctx.toolName === 'bash'
        ? `Run bash: $ ${args.command}`
        : `Write file: ${args.path}`

    const answer = await this.askPermission(prompt)

    if (answer === 'yes') {
      return { action: 'continue' }
    }

    if (answer === 'session') {
      this.sessionAllowed.add(key)
      return { action: 'continue' }
    }

    // answer === 'no'
    return { action: 'block', reason: 'User denied permission' }
  }

  /** 供外部查看当前会话放行了哪些操作（调试用） */
  get sessionAllowedKeys(): string[] {
    return Array.from(this.sessionAllowed)
  }
}
