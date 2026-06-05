import EventEmitter from 'events'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { DiffLine } from '../tools/edittool.js'
import type { ChatMessage, ChoiceEvent, ChoiceQuestion, ChoiceResult, MessageRole, PermissionEvent, QuestionEvent, UsageStats } from './types.js'
import type { MCPServerInfo } from '../mcp/mcpmanager.js'
import type { TodoPlanSnapshot } from '../todos/todo.js'

/**
 * Sub-agent task state exposed by bridge events to the TUI panel.
 * Mirrors Claude Code's LocalAgentTaskState but streamlined.
 */
export interface SubAgentTask {
  id: string
  name: string               // agent name, e.g. "explore", "generator"
  description: string         // task description from input
  agentType: string           // e.g. "explore", "general-purpose"
  status: 'running' | 'completed' | 'failed' | 'killed'
  startTime: number
  endTime?: number
  toolUseCount: number
  tokenCount: number
  lastActivity?: string       // e.g. "Reading src/foo.ts…"
  summary?: string            // periodic background summary
  error?: string
}

export class TuiBridge extends EventEmitter {
  private _autoMode = true
  private _backgroundCount = 0

  /**
   * 启动时由 agent.ts 设置，存放从 checkpoint 恢复的历史消息（ChatMessage[]）。
   * App.tsx 启动时从该属性读取并初始化 messages state。
   * 仅在 session 恢复（--continue / -c）时非空。
   */
  initialMessages: ChatMessage[] = []

  get autoMode() {
    return this._autoMode
  }

  get backgroundCount() {
    return this._backgroundCount
  }

  toggleAutoMode() {
    this._autoMode = !this._autoMode
    this.emit('autoModeChange', this._autoMode)
    return this._autoMode
  }

  /** 后台任务启动时调用，更新计数。 */
  emitBackgroundStart() {
    this._backgroundCount++
    this.emit('backgroundCount', this._backgroundCount)
  }

  /** 后台任务完成/失败时调用，更新计数。 */
  emitBackgroundEnd() {
    this._backgroundCount = Math.max(0, this._backgroundCount - 1)
    this.emit('backgroundCount', this._backgroundCount)
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

  // ── Sub-agent lifecycle events ──────────────────────────────────────

  /** Sub-agent started: creates a new row in the task panel. */
  emitSubAgentStart(name: string, description: string, agentType: string) {
    this.emit('subAgentStart', {
      name,
      description,
      agentType,
      startTime: Date.now(),
    })
  }

  /** Sub-agent progress update: tool counts, token counts, current activity. */
  emitSubAgentProgress(name: string, toolUseCount: number, tokenCount: number, lastActivity?: string) {
    this.emit('subAgentProgress', { name, toolUseCount, tokenCount, lastActivity })
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

  /** 子 agent 执行完毕，TUI 从面板移除任务行。status may be 'completed'|'failed'|'killed'. */
  emitSubAgentDone(name: string, status: 'completed' | 'failed' | 'killed', error?: string) {
    this.emit('subAgentDone', { name, status, error })
  }

  // ── Todo Plan 事件 ──────────────────────────────────────────────────

  /** Todo plan 创建、任务状态变更时发出。snapshot 为 null 表示 plan 已清空。 */
  emitTodoPlanUpdate(snapshot: TodoPlanSnapshot | null) {
    this.emit('todoPlanUpdate', snapshot)
  }
}
