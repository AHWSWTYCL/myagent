import { Command } from './command.js'
import { CommandRegistry } from './commandregistry.js'

export class HelpCommand extends Command {
  constructor(private registry: CommandRegistry) {
    super()
  }

  get name(): string {
    return 'help'
  }

  get description(): string {
    return '列出所有可用命令'
  }

  get usage(): string {
    return '/help'
  }

  async execute(_args: string[]): Promise<void> {
    const commands = this.registry.getAll()
    console.log('可用命令：')
    for (const cmd of commands) {
      console.log(`  /${cmd.name} — ${cmd.description}`)
      console.log(`  用法：${cmd.usage}`)
    }
  }
}
