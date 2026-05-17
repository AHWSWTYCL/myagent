export abstract class Skill {
  abstract get name(): string
  abstract get description(): string
  abstract get prompt(): string
}
