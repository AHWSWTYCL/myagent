import { Command } from './command.js'

export interface Suggestion {
  name: string
  description: string
  usage: string
}

export class CommandRegistry {
  private commands: Map<string, Command> = new Map()

  register(command: Command): void {
    this.commands.set(command.name, command)
  }

  get(name: string): Command | undefined {
    return this.commands.get(name)
  }

  getAll(): Command[] {
    return [...this.commands.values()]
  }

  /** 按前缀搜索命令名，返回匹配的建议列表 */
  search(prefix: string): Suggestion[] {
    if (!prefix) return []
    const lower = prefix.toLowerCase()
    return this.getAll()
      .filter(cmd => cmd.name.toLowerCase().startsWith(lower))
      .map(cmd => ({ name: cmd.name, description: cmd.description, usage: cmd.usage }))
  }
}
