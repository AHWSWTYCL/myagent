import * as readline from 'readline'
import { Hook, HookContext, HookResult } from './hook.js'

// 对危险操作（write_file / bash）要求用户确认，替代原来硬编码的 checkPermission
export class PermissionHook implements Hook {
  name = 'PermissionHook'

  private rl: readline.Interface

  constructor(rl: readline.Interface) {
    this.rl = rl
  }

  async onToolCall(ctx: HookContext): Promise<HookResult> {
    const dangerousTools = ['write_file', 'bash']
    if (!dangerousTools.includes(ctx.toolName)) {
      return { action: 'continue' }
    }

    const args = ctx.toolInput as Record<string, string>
    let prompt: string
    if (ctx.toolName === 'bash') {
      prompt = `The agent wants to run a bash command:\n  $ ${args.command}\nDo you allow this? (yes/no) `
    } else {
      prompt = `The agent wants to write a file:\n  ${args.path}\nDo you allow this? (yes/no) `
    }
    const answer = await this.question(prompt)
    const allowed = answer.trim().toLowerCase()

    if (allowed === 'yes' || allowed === 'y') {
      return { action: 'continue' }
    }
    return { action: 'block', reason: 'User denied permission' }
  }

  private question(prompt: string): Promise<string> {
    return new Promise(resolve => this.rl.question(prompt, resolve))
  }
}
