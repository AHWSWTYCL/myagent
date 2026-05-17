import { Command } from './command.js'

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
}
