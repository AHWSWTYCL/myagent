import { CommandRegistry } from './commandregistry.js'

export class CommandParser {
  constructor(private registry: CommandRegistry) {}

  isCommand(input: string): boolean {
    return input.startsWith('/')
  }

  async dispatch(input: string): Promise<boolean> {
    const parts = input.slice(1).split(' ').filter(s => s.length > 0)
    if (parts.length === 0) return false

    const commandName = parts[0]
    const args = parts.slice(1)

    const command = this.registry.get(commandName)
    if (!command) {
      console.log(`未知命令: ${commandName}，输入 /help 查看可用命令`)
      return false
    }

    await command.execute(args)
    return true
  }
}
