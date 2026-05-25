import EventEmitter from 'events'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { DiffLine } from '../tools/edittool.js'
import type { ChoiceEvent, ChoiceQuestion, ChoiceResult, MessageRole, PermissionEvent, QuestionEvent, UsageStats } from './types.js'

export class TuiBridge extends EventEmitter {
  private _autoMode = false

  get autoMode() {
    return this._autoMode
  }

  toggleAutoMode() {
    this._autoMode = !this._autoMode
    this.emit('autoModeChange', this._autoMode)
    return this._autoMode
  }

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

  askChoice(questions: ChoiceQuestion[]): Promise<ChoiceResult> {
    return new Promise(resolve => {
      this.emit('choice', { questions, resolve } satisfies ChoiceEvent)
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

  /** Called when context compaction starts or finishes. state='start'|'done'|'micro' */
  emitCompacting(state: 'start' | 'done' | 'micro', detail?: string) {
    this.emit('compacting', { state, detail })
  }

  /** Called after context compaction — resets the token counter in the TUI. */
  emitUsageReset() {
    this.emit('usageReset')
  }

  /** Called when an edit_file result is received, with structured diff data. */
  emitEditDiff(filePath: string, lines: DiffLine[], additions: number, removals: number) {
    this.emit('editDiff', { filePath, lines, additions, removals })
  }

  /** Called when relevant memory is recalled for the current query. */
  emitRecall(memory: string) {
    this.emit('recall', memory)
  }

}
