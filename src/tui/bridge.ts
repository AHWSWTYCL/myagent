import EventEmitter from 'events'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { DiffLine } from '../tools/edittool.js'
import type { ChatMessage, ChoiceEvent, ChoiceQuestion, ChoiceResult, MessageRole, PermissionEvent, QuestionEvent, UsageStats } from './types.js'
import type { MCPServerInfo } from '../mcp/mcpmanager.js'
import type { TodoPlanSnapshot } from '../todos/todo.js'
import type { TeammateTaskInfo } from '../team/taskRegistry.js'
import { appStateStore, type AppStateStore } from '../state/appState.js'

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
  constructor(private readonly store: AppStateStore = appStateStore) {
    super()
  }

  get mode() {
    return this.store.getState().mode
  }

  get isAutoMode() {
    return this.store.getState().mode === 'auto'
  }

  get backgroundCount() {
    return this.store.getState().backgroundCount
  }

  /** Shift+Tab 三态循环：default → auto → plan → default
   *
   * 注意：plan → default 是用户主动操作，直接退出无需确认。
   * LLM 退出 plan mode 必须走 ExitPlanModeTool 的两阶段确认流程（先询问用户是否接受计划）。
   * 两个退出路径互不干扰：用户用 Shift+Tab 强制退出，LLM 用工具确认后退出。 */
  cycleMode(): string {
    const current = this.store.getState().mode
    const cycle: Record<string, string> = { default: 'auto', auto: 'plan', plan: 'default' }
    const next = cycle[current] || 'auto'
    this.store.setState(prev => {
      const updates: Partial<typeof prev> = { mode: next as typeof prev['mode'] }
      // 进入 plan mode 时记录 previous mode
      if (next === 'plan') {
        updates.planPreviousMode = current === 'plan' ? prev.planPreviousMode : (current as 'default' | 'auto')
        updates.planQueryCount = 0
      }
      // 退出 plan mode 时清除 previous mode
      if (current === 'plan' && next !== 'plan') {
        updates.planPreviousMode = null
        updates.planQueryCount = 0
      }
      return { ...prev, ...updates }
    })
    this.emit('modeChange', next)
    return next
  }

  /** 通过工具进入 plan mode，记住当前 mode */
  enterPlanMode(): string {
    const current = this.store.getState().mode
    if (current === 'plan') return 'plan'
    this.store.setState(prev => ({
      ...prev,
      mode: 'plan',
      planPreviousMode: current as 'default' | 'auto',
      planQueryCount: 0,
    }))
    this.emit('modeChange', 'plan')
    return 'plan'
  }

  /** 退出 plan mode，恢复到之前的 mode */
  exitPlanMode(): string {
    const current = this.store.getState().mode
    if (current !== 'plan') return current
    const prev = this.store.getState().planPreviousMode || 'default'
    this.store.setState(s => ({
      ...s,
      mode: prev,
      planPreviousMode: null,
      planQueryCount: 0,
    }))
    this.emit('modeChange', prev)
    return prev
  }

  /** 后台任务启动时调用，更新计数。 */
  emitBackgroundStart() {
    const next = this.store.getState().backgroundCount + 1
    this.store.setState(prev => ({ ...prev, backgroundCount: next }))
    this.emit('backgroundCount', next)
  }

  /** 后台任务完成/失败时调用，更新计数。 */
  emitBackgroundEnd() {
    const next = Math.max(0, this.store.getState().backgroundCount - 1)
    this.store.setState(prev => ({ ...prev, backgroundCount: next }))
    this.emit('backgroundCount', next)
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
    this.store.setState(prev => prev.status === msg ? prev : { ...prev, status: msg })
    this.emit('status', msg)
  }

  /** Requests that the current turn be aborted — mirrors what pressing Esc does in the TUI. */
  emitAbortRequested() {
    this.emit('abortRequested')
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
    this.store.setState(prev => ({ ...prev, usage: stats }))
    this.emit('usage', stats)
  }

  /** Called at the start of each new LLM round's tool phase — UI clears previous round's tool entries. */
  emitTurnToolReset() {
    this.emit('turnToolReset')
  }

  /** Called when context compaction starts or finishes. state='start'|'done'|'micro' */
  emitCompacting(state: 'start' | 'done' | 'micro', detail?: string) {
    const compactingState = state === 'start' ? 'running' : state === 'micro' ? 'micro' : 'idle'
    this.store.setState(prev => ({ ...prev, compactingState }))
    this.emit('compacting', { state, detail })
  }

  /** Called after context compaction — resets the token counter in the TUI. */
  emitUsageReset() {
    this.store.setState(prev => prev.usage === null ? prev : { ...prev, usage: null })
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
    this.store.setState(prev => ({ ...prev, mcpServers: servers }))
    this.emit('mcp-status', servers)
  }

  // ── Sub-agent lifecycle events ──────────────────────────────────────

  /** Sub-agent started: creates a new row in the task panel. */
  emitSubAgentStart(name: string, description: string, agentType: string) {
    const startTime = Date.now()
    this.store.setState(prev => {
      const existing = prev.subAgentTasks.find(t => t.name === name && t.status === 'running')
      if (existing) return prev
      return {
        ...prev,
        subAgentTasks: [...prev.subAgentTasks, {
          id: `${name}-${startTime}`,
          name,
          description,
          agentType,
          status: 'running',
          startTime,
          toolUseCount: 0,
          tokenCount: 0,
        }],
      }
    })
    this.emit('subAgentStart', {
      name,
      description,
      agentType,
      startTime,
    })
  }

  /** Sub-agent progress update: tool counts, token counts, current activity. */
  emitSubAgentProgress(name: string, toolUseCount: number, tokenCount: number, lastActivity?: string) {
    this.store.setState(prev => ({
      ...prev,
      subAgentTasks: prev.subAgentTasks.map(t =>
        t.name === name && t.status === 'running'
          ? { ...t, toolUseCount, tokenCount, lastActivity }
          : t,
      ),
    }))
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
    const endTime = Date.now()
    this.store.setState(prev => ({
      ...prev,
      subAgentTasks: prev.subAgentTasks.map(t =>
        t.name === name && t.status === 'running'
          ? { ...t, status, endTime, error }
          : t,
      ),
    }))
    this.emit('subAgentDone', { name, status, error })
  }

  // ── Todo Plan 事件 ──────────────────────────────────────────────────

  /** Todo plan 创建、任务状态变更时发出。snapshot 为 null 表示 plan 已清空。 */
  emitTodoPlanUpdate(snapshot: TodoPlanSnapshot | null) {
    this.store.setState(prev => ({ ...prev, todoPlan: snapshot }))
    this.emit('todoPlanUpdate', snapshot)
  }

  // ── Teammate task events ───────────────────────────────────────────

  /** Teammate 任务注册表变更时发出。tasks 为当前全部 teammate 列表。 */
  emitTeammateTasks(tasks: TeammateTaskInfo[]) {
    this.store.setState(prev => ({ ...prev, teammateTasks: tasks }))
    this.emit('teammateTasks', tasks)
  }
}
