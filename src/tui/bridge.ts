import EventEmitter from 'events'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { DiffLine } from '../tools/edittool.js'
import type { ChoiceEvent, ChoiceQuestion, ChoiceResult, MessageRole, PermissionEvent, QuestionEvent, UsageStats } from './types.js'
import type { MCPServerInfo } from '../mcp/mcpmanager.js'

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

  /** Called just before a tool starts executing — lets the TUI show a pending row keyed by callId. */
  emitToolStart(callId: string, name: string, input: unknown) {
    this.emit('toolStart', { callId, name, input })
  }

  /** Called when a tool finishes (success or error). */
  emitToolEnd(callId: string, name: string, input: unknown, output: string) {
    this.emit('toolEnd', { callId, name, input, output })
  }

  /** Called after each API turn with cumulative token counts. */
  emitUsage(stats: UsageStats) {
    this.emit('usage', stats)
  }

  /** Called at the start of each new LLM round's tool phase — UI clears previous round's tool entries. */
  emitTurnToolReset() {
    this.emit('turnToolReset')
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

  /** Called when MCP server status changes. */
  emitMcpStatus(servers: MCPServerInfo[]) {
    this.emit('mcp-status', servers)
  }

  /**
   * 子 agent 实时输出：逐字符或逐段推送，TUI 在 tool spinner 下方渲染。
   * name 是 agent 名（如 project_builder），delta 是增量文本。
   */
  emitSubAgentDelta(name: string, delta: string) {
    this.emit('subAgentDelta', { name, delta })
  }

  /**
   * 子 agent 内长时间静默命令的心跳。TUI 据此渲染一个动画行，告诉用户「还活着」。
   * elapsedMs 是命令开始到此次心跳的总耗时（毫秒）。
   * 一旦 stdout/stderr 有新数据，后端就停止发心跳；TUI 自己用计时器判断超时清掉动画。
   */
  emitSubAgentHeartbeat(name: string, elapsedMs: number) {
    this.emit('subAgentHeartbeat', { name, elapsedMs })
  }

  /** 子 agent 执行完毕，TUI 清理实时面板并将输出归档为静态消息。 */
  emitSubAgentDone(name: string) {
    this.emit('subAgentDone', { name })
  }

}
