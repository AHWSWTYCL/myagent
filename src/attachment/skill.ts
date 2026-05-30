import { Attachment } from './attachment.js'

export class SkillAttachment extends Attachment {
  readonly type = 'skill'

  constructor(
    public readonly skillName: string,
    public readonly action: 'activated' | 'deactivated',
  ) {
    super('skillManager')
  }

  get summary(): string {
    return `Skill "${this.skillName}" ${this.action}`
  }

  get content(): string {
    const verb = this.action === 'activated' ? 'activated' : 'deactivated'
    return `Skill "${this.skillName}" has been ${verb}.`
  }
}
