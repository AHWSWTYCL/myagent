import { Attachment } from './attachment.js'

export class AgentAttachment extends Attachment {
  readonly type = 'agent'

  constructor(
    public readonly agentName: string,
    public readonly description: string,
  ) {
    super('agentRegistry')
  }

  get summary(): string {
    return `Agent "${this.agentName}" registered`
  }

  get content(): string {
    return `New sub-agent registered: "${this.agentName}" — ${this.description}`
  }
}
