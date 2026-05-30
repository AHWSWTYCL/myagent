import { Attachment } from './attachment.js'

export class TaskStatusAttachment extends Attachment {
  readonly type = 'task_status'

  constructor(
    public readonly planId: string,
    public readonly taskIndex: number,
    public readonly description: string,
    public readonly status: string,
    public readonly error?: string,
  ) {
    super('todoManager')
  }

  get summary(): string {
    return `Task #${this.taskIndex} → ${this.status}`
  }

  get content(): string {
    let s = `Task #${this.taskIndex} "${this.description}" status changed to ${this.status}`
    if (this.error) s += `, error: ${this.error}`
    return s
  }
}

export class TaskPlanCreatedAttachment extends Attachment {
  readonly type = 'task_plan_created'

  constructor(
    public readonly description: string,
    public readonly taskCount: number,
  ) {
    super('todoManager')
  }

  get summary(): string {
    return `Plan "${this.description}" created with ${this.taskCount} tasks`
  }

  get content(): string {
    return `New task plan created: "${this.description}" (${this.taskCount} tasks)`
  }
}

export class TaskPlanClearedAttachment extends Attachment {
  readonly type = 'task_plan_cleared'

  constructor(public readonly planId: string) {
    super('todoManager')
  }

  get summary(): string {
    return `Plan ${this.planId} cleared`
  }

  get content(): string {
    return `Task plan cleared (all tasks completed or plan reset)`
  }
}
