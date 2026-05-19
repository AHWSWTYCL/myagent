import EventEmitter from 'events'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { MessageRole, PermissionEvent, QuestionEvent, UsageStats } from './types.js'

export class TuiBridge extends EventEmitter {
  askPermission(prompt: string): Promise<PermissionAnswer> {
    return new Promise(resolve => {
      this.emit('permission', { prompt, resolve } satisfies PermissionEvent)
    })
  }

  askQuestion(prompt: string): Promise<string> {
    return new Promise(resolve => {
      this.emit('question', { prompt, resolve } satisfies QuestionEvent)
    })
  }

  emitStatus(msg: string) {
    this.emit('status', msg)
  }

  emitText(delta: string) {
    this.emit('text', delta)
  }

  /** Called when one agent turn finishes streaming (before tool calls run). */
  emitTurnEnd(text: string) {
    this.emit('turnEnd', text)
  }

  emitMessage(role: MessageRole, content: string) {
    this.emit('message', { role, content })
  }

  /** Called just before a tool starts executing — lets the TUI show a spinner. */
  emitToolStart(name: string, summary: string) {
    this.emit('toolStart', { name, summary })
  }

  /** Called after each API turn with cumulative token counts. */
  emitUsage(stats: UsageStats) {
    this.emit('usage', stats)
  }
}
