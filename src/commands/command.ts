export abstract class Command {
  abstract get name(): string
  abstract get description(): string
  abstract get usage(): string
  abstract execute(args: string[]): Promise<void>
}
