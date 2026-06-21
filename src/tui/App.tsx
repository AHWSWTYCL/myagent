import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { ChatMessage, ChoiceEvent, ChoiceQuestion, ChoiceResult, PermissionEvent, QuestionEvent, QuestionSuggestion } from './types.js'
import type { TuiBridge } from './bridge.js'
import type { DiffLine } from '../tools/edittool.js'
import type { CommandParser } from '../commands/commandparser.js'
import type { Suggestion } from '../commands/commandregistry.js'
import type { FileAttachment } from '../utils/attachments.js'
import type { Tool } from '../tools/tool.js'
import { parseAttachments, buildUserContent, autoPrefixAttachments } from '../utils/attachments.js'
import { extractAtToken, getFileSuggestions, applyFileCompletion } from './fileSuggestions.js'
import { StreamingText } from './MarkdownRenderer.js'
import { Banner } from './banner.js'
import { McpStatusPanel } from './McpStatusPanel.js'
import { MessageRow } from './MessageRow.js'
import { Spinner } from './Spinner.js'
import { PermissionPrompt, ChoicePrompt } from './Prompts.js'
import { InputBox, Footer, buildCtx } from './InputBox.js'
import { PendingToolRow, ToolCallView } from './ToolCallView.js'
import { GroupedToolCallView } from './GroupedToolCallView.js'
import { TurnSummary, EXPLORATION_TOOLS } from './TurnSummary.js'
import { ToolRenderProvider } from './ToolRenderContext.js'
import type { TurnToolItem } from './types.js'
import { getVisibleTasks } from './SubAgentTaskPanel.js'
import { TodoPanel } from './TodoPanel.js'
import { TODO_STATUS_ICON, type TodoPlanSnapshot } from '../todos/todo.js'
import { ttsService } from '../voice/tts.js'
import { BackgroundTasksDialog } from './BackgroundTasksDialog.js'
import { WorkflowsDialog, type WorkflowsDialogView } from './WorkflowsDialog.js'
import { workflowRegistry } from '../workflow/registry.js'
import { TeammateConversationView } from './TeammateConversationView.js'
import { Mailbox } from '../mailbox/mailbox.js'
import { goalManager } from '../goal/goalManager.js'
import { useAppState, useSetAppState } from '../state/AppStateProvider.js'
import { setStdioLogSink } from '../mcp/mcptransport.js'
import { QuestionAutofillManager } from './QuestionAutofillManager.js'
import { speculativeRunner } from '../speculative/speculativeRunner.js'
import { sessionState } from '../state/sessionState.js'
import type Anthropic from '@anthropic-ai/sdk'

type InputMode = 'chat' | 'permission' | 'question' | 'choice'
type AppMode = 'main' | 'backgroundTasks' | 'teammateView' | 'workflowsDialog'
type RunMode = 'main' | 'teammate'

interface Props {
  bridge: TuiBridge
  commandParser: CommandParser
  runTurn: (input: string | any[], signal?: AbortSignal, backgroundSignal?: AbortSignal) => Promise<{ backgrounded?: boolean } | void>
  runBash: (cmd: string) => Promise<string>
  toolMap: Map<string, Tool>
  enqueueUserMessage: (msg: string) => void
  enqueueMainMailboxWake: () => void
  subscribeQueue: (listener: () => void) => () => void
  subscribeMainMailbox?: (listener: () => void) => () => void
  hasUnreadMainMail?: () => boolean
  getQueueLength: () => number
  dequeueMessage: () => string | undefined
  initialMessages?: ChatMessage[]
  /** 构建 system prompt（用于 speculative execution 等需要复用 prompt 的场景） */
  buildSystemSegments?: () => Anthropic.TextBlockParam[]
  /** Teammate mode props */
  mode?: RunMode
  teammateAgentId?: string
  teammateLeaderId?: string
}

const MAX_HISTORY = 100
const MAX_CONTEXT = 200_000

/**
 * Build a render plan with the TurnSummary placed at the END.
 *
 * All exploration tools (read_file/list_dir/glob/grep) are collapsed into a
 * single TurnSummary at the very end of the plan. Non-exploration tools
 * maintain their relative order and are grouped by consecutive same-name.
 *
 * Example: bash → read_file → bash → grep → edit
 *   plan = [
 *     { type: 'tool-group', items: [bash, bash] },  ← merged!
 *     { type: 'tool-group', items: [edit] },
 *     { type: 'summary' },                           ← at the end
 *   ]
 *
 * This ensures same-name non-exploration tools are never split by the summary
 * boundary, and exploration research is summarized as a block after all actions.
 */
type RenderPlanItem =
  | { type: 'summary' }
  | { type: 'tool-group'; items: TurnToolItem[] }

function buildRenderPlan(turnTools: TurnToolItem[]): RenderPlanItem[] {
  const plan: RenderPlanItem[] = []
  let hasExploration = false
  let pendingGroup: TurnToolItem[] | null = null

  function flushGroup() {
    if (pendingGroup && pendingGroup.length > 0) {
      plan.push({ type: 'tool-group', items: pendingGroup })
      pendingGroup = null
    }
  }

  for (const tool of turnTools) {
    if (EXPLORATION_TOOLS.has(tool.name)) {
      hasExploration = true
      // Don't insert summary here — collect the flag and continue.
      // Exploration tools are NOT added to any tool-group.
      continue
    }

    // Non-exploration tool: group consecutive same-name tools.
    if (pendingGroup && pendingGroup[0].name === tool.name) {
      pendingGroup.push(tool)
    } else {
      flushGroup()
      pendingGroup = [tool]
    }
  }

  flushGroup()

  // Summary goes at the very end, after all non-exploration groups.
  if (hasExploration) {
    plan.push({ type: 'summary' })
  }

  return plan
}

export function App({ bridge, commandParser, runTurn, runBash, toolMap, enqueueUserMessage, enqueueMainMailboxWake, subscribeQueue, subscribeMainMailbox, hasUnreadMainMail, getQueueLength, dequeueMessage, initialMessages = [], buildSystemSegments, mode = 'main', teammateAgentId, teammateLeaderId }: Props) {
  const { exit } = useApp()
  const setAppState = useSetAppState()
  const [messages, rawSetMessages] = useState<ChatMessage[]>(() => initialMessages)
  const messagesRef = useRef(messages)
  const setMessages = useCallback((action: React.SetStateAction<ChatMessage[]>) => {
    const next = typeof action === 'function'
      ? (action as (prev: ChatMessage[]) => ChatMessage[])(messagesRef.current)
      : action
    messagesRef.current = next
    rawSetMessages(next)
  }, [])
  const [streamingText, setStreamingText] = useState('')
  const status = useAppState(s => s.status)
  // 当前用户输入轮次内正在执行（pending）的工具。
  // 每个 LLM round 结束时，turnToolReset 将已完成工具全部移入 Static，
  // turnTools 只保留 pending 工具在动态区实时显示。
  const [turnTools, setTurnTools] = useState<TurnToolItem[]>([])
  const usage = useAppState(s => s.usage)
  const [inputValue, setInputValue] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [inputMode, setInputMode] = useState<InputMode>('chat')
  const [permissionChoice, setPermissionChoice] = useState<0 | 1 | 2>(0)
  // ── choice 模式状态 ─────────────────────────────────────────────────
  const [choiceQuestions, setChoiceQuestions] = useState<ChoiceQuestion[]>([])
  const [choiceSelections, setChoiceSelections] = useState<number[]>([])
  // 焦点行：0..n-1 是问题，n 是 Submit 按钮，n+1 是 Cancel 按钮
  const [choiceFocus, setChoiceFocus] = useState(0)
  // "Other…" 自定义输入
  const [choiceCustomActive, setChoiceCustomActive] = useState<number | null>(null) // 正在输入的问题索引
  const [choiceCustomInput, setChoiceCustomInput] = useState('') // 输入草稿
  const [choiceCustomValues, setChoiceCustomValues] = useState<Record<number, string>>({}) // 已提交的自定义值
  // ── Ghost text 输入建议 ────────────────────────────────────────────
  const [ghostText, setGhostText] = useState<string | null>(null)
  const [autofillEnabled, setAutofillEnabled] = useState(false)
  const autofillManagerRef = useRef(new QuestionAutofillManager())
  const autofillGenRef = useRef(0)
  const autofillEnabledRef = useRef(false)
  const inputModeRef = useRef<InputMode>("chat")
  // ── prompt 等 ──────────────────────────────────────────────────────
  const [promptText, setPromptText] = useState('')
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const agentMode = useAppState(s => s.mode)
  // Ctrl+O toggles full output for every tool message in the chat.
  const [expandAll, setExpandAll] = useState(false)
  // Ctrl+L toggles MCP stdio log display
  const [showMcpStdioLogs, setShowMcpStdioLogs] = useState(false)
  const [mcpStdioLogs, setMcpStdioLogs] = useState<string[]>([])
  const MAX_STDIO_LOGS = 200
  const compactingState = useAppState(s => s.compactingState)
  // 临时提示条（footer 上方淡出消息），不进聊天历史
  const [transientHint, setTransientHint] = useState('')
  const transientHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 历史导航前的草稿（首次按 ↑ 时暂存，回到底时还原）
  const [draftBeforeHistory, setDraftBeforeHistory] = useState<string | null>(null)
  // spinner state lives inside Spinner component now; we just track elapsed time
  const [activityStartedAt, setActivityStartedAt] = useState<number | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  // ── 命令补全相关状态 ──────────────────────────────────────────────
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0)
  // ── @ 文件路径补全相关状态 ─────────────────────────────────────────
  const [cursorOffset, setCursorOffset] = useState(0)
  const cursorOffsetRef = useRef(cursorOffset)
  cursorOffsetRef.current = cursorOffset
  const [atToken, setAtToken] = useState<{ start: number; end: number } | null>(null)
  const pendingFileSuggestRef = useRef<string | null>(null)
  const pendingResolveRef = useRef<((v: any) => void) | null>(null)
  const handleCursorChange = useCallback((offset: number) => setCursorOffset(offset), [])
  const idCounter = useRef(0)
  const streamingRef = useRef('')
  const historyIndexRef = useRef(-1)
  const abortControllerRef = useRef<AbortController | null>(null)
  const bgControllerRef = useRef<AbortController | null>(null) // Ctrl+B → background handoff
  const isProcessingRef = useRef(false)    // 同步版 isProcessing，避免闭包过期
  const submittingRef = useRef(false)      // 防止 handleSubmit 并发
  const turnEndedRef = useRef(false)       // 防止 turnEnd 后的 text delta 复活 streaming
  const lastSpeculationTextRef = useRef<string | null>(null)  // 追踪上次预测文本，用于 submit 时匹配

  // ── 稳定 props 引用（防止 processQueue useCallback 每次渲染变化）──
  // runTurn/getQueueLength/dequeueMessage 等来自父组件的 props 不是
  // useCallback 包裹的，每次渲染都是新引用 → 如果直接作为 useCallback
  // 依赖会导致 processQueue 每次渲染都变化 → subscribeQueue/unreadCheck
  // 的 useEffect 频繁重订阅 → 与 useSyncExternalStore 的 tearing check
  // 结合形成无限重渲染循环。
  //
  // 修复策略：所有从 props 来的函数用 ref 捕获最新引用，effect 只依赖 []。
  // processQueue 自身也存入 ref，避免它成为其他 effect 的 deps 级联变化源。
  const runTurnRef = useRef(runTurn)
  runTurnRef.current = runTurn
  const getQueueLengthRef = useRef(getQueueLength)
  getQueueLengthRef.current = getQueueLength
  const dequeueMessageRef = useRef(dequeueMessage)
  dequeueMessageRef.current = dequeueMessage
  const hasUnreadMainMailRef = useRef(hasUnreadMainMail)
  hasUnreadMainMailRef.current = hasUnreadMainMail
  const enqueueMainMailboxWakeRef = useRef(enqueueMainMailboxWake)
  enqueueMainMailboxWakeRef.current = enqueueMainMailboxWake
  const subscribeQueueRef = useRef(subscribeQueue)
  subscribeQueueRef.current = subscribeQueue
  const subscribeMainMailboxRef = useRef(subscribeMainMailbox)
  subscribeMainMailboxRef.current = subscribeMainMailbox
  // processQueueRef：避免 processQueue 进入其他 effect 的 dependency array
  // 所有调用 processQueue 的地方都通过 processQueueRef.current() 间接调用
  const processQueueRef = useRef<() => Promise<void>>(async () => {})

  const nextId = useCallback(() => String(++idCounter.current), [])

  // ── Edit diff 状态 ──────────────────────────────────────────────────
  const [editDiffs, setEditDiffs] = useState<Array<{ id: string; filePath: string; lines: DiffLine[]; additions: number; removals: number }>>([])

  // ── 工具键盘导航 ──────────────────────────────────────────────────
  // 已废弃：非探索工具完成时直接从 turnTools 移除并进入 Static，
  // 不再在动态区域中停留，因此无需 Tab 导航和 per-tool 展开状态。
  // 所有工具展开/折叠通过 Ctrl+O 全局控制（expandAll）。

  // ── 附件状态 ────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([])
  const pendingAttachmentCheckRef = useRef<string | null>(null) // 防止异步竞态

  // ── Goal 状态（goalManager 是普通单例，不触发 React re-render） ──────
  const [goalText, setGoalText] = useState<string | undefined>(() =>
    goalManager.isActive() ? `🎯 ${(goalManager.getGoal() ?? '').slice(0, 20)} [${goalManager.getIteration()}/${goalManager.getMaxIterations()}]` : undefined
  )
  const refreshGoalText = useCallback(() => {
    setGoalText(goalManager.isActive()
      ? `🎯 ${(goalManager.getGoal() ?? '').slice(0, 20)} [${goalManager.getIteration()}/${goalManager.getMaxIterations()}]`
      : undefined)
  }, [])

  // ── MCP 状态 ─────────────────────────────────────────────────────────
  const mcpServers = useAppState(s => s.mcpServers)

  // ── 子 agent 任务面板状态 ─────────────────────────────────────────────
  const subAgentTasks = useAppState(s => s.subAgentTasks)
  const visibleTasks = getVisibleTasks(subAgentTasks)

  // ── 后台任务计数（用于 Footer [bg:N] 指示器） ───────────────────────
  const backgroundCount = useAppState(s => s.backgroundCount)

  // ── 子 agent 实时输出（路由到 pending agent tool 的 liveOutput）────
  const todoPlan = useAppState(s => s.todoPlan)

  // ── Background Tasks Dialog state ───────────────────────────────────
  const [appMode, setAppMode] = useState<AppMode>('main')
  const teammateTasks = useAppState(s => s.teammateTasks)
  const [dialogSelectedIndex, setDialogSelectedIndex] = useState(0)
  const [selectedTeammateId, setSelectedTeammateId] = useState<string | null>(null)

  // ── Workflows Dialog state ────────────────────────────────────────────
  const [workflowSelectedIndex, setWorkflowSelectedIndex] = useState(0)
  const [workflowDialogView, setWorkflowDialogView] = useState<WorkflowsDialogView>('list')
  const [workflowRuns, setWorkflowRuns] = useState(() => workflowRegistry.list())

  // 每秒刷新 workflow 数据（dialog 打开时）
  useEffect(() => {
    if (appMode !== 'workflowsDialog') return
    const t = setInterval(() => setWorkflowRuns(workflowRegistry.list()), 1000)
    return () => clearInterval(t)
  }, [appMode])

  // ── Todo plan 完成态跃迁跟踪（防重复发射静态消息） ────────────────
  const todoSnapshotEmittedRef = useRef(false)
  /** 暂存 todo snapshot 内容，待到 turnEnd 时插入（确保在所有 tool 结果之后、LLM 总结之前） */
  const pendingTodoSnapshotRef = useRef<string | null>(null)

  // turnToolsRef：同步最新 turnTools，供 useEffect 中的事件回调访问
  const turnToolsRef = useRef(turnTools)
  turnToolsRef.current = turnTools

  historyIndexRef.current = historyIndex
  // 同步 ref 与 state，供 useInput/handleSubmit 使用最新值避免闭包过期
  isProcessingRef.current = isProcessing

  // ── activity (tool/status) elapsed seconds ────────────────────────
  const isActive = turnTools.some(t => t.isPending) || !!status
  const activityStartedRef = useRef(false)
  useEffect(() => {
    if (!isActive) {
      activityStartedRef.current = false
      setActivityStartedAt(null)
      setElapsedSec(0)
      return
    }
    // 已经在计时就不要重置，防止多工具并发时重复 setState
    if (activityStartedRef.current) return
    activityStartedRef.current = true
    setActivityStartedAt(Date.now())
  }, [isActive])

  useEffect(() => {
    if (!activityStartedAt) return
    const t = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - activityStartedAt) / 1000))
    }, 250)
    return () => clearInterval(t)
  }, [activityStartedAt])

  // 同步 autofillEnabled 到 ref，供事件闭包读取最新值
  useEffect(() => { autofillEnabledRef.current = autofillEnabled }, [autofillEnabled])
  useEffect(() => { inputModeRef.current = inputMode }, [inputMode])

  // ── Ghost text：ask_user / ask_user_choice 中镇压 ──────────────────

  const showHint = useCallback((text: string, ms = 2000) => {
    setTransientHint(text)
    if (transientHintTimerRef.current) clearTimeout(transientHintTimerRef.current)
    transientHintTimerRef.current = setTimeout(() => setTransientHint(''), ms)
  }, [])

  useEffect(() => {
    const unsubscribers: Array<() => void> = []
    const on = (event: string, handler: (...args: any[]) => void) => {
      bridge.on(event, handler)
      unsubscribers.push(() => bridge.off(event, handler))
    }

    on('text', (delta: string) => {
      if (turnEndedRef.current) return  // 防止 turnEnd 后迟到达的 delta 复活 streaming
      streamingRef.current += delta
      setStreamingText(streamingRef.current)
    })

    on('turnEnd', (text: string) => {
      if (!text) return
      // 先标记 turnEnd + 清除动态 streaming，防止与 Static 中 agent 消息「同框双显」
      turnEndedRef.current = true
      streamingRef.current = ''
      setStreamingText('')
      const entries: ChatMessage[] = [{ id: nextId(), role: 'agent', content: text }]
      if (pendingTodoSnapshotRef.current) {
        entries.unshift({ id: nextId(), role: 'system', content: pendingTodoSnapshotRef.current })
        pendingTodoSnapshotRef.current = null
      }
      setMessages(prev => [...prev, ...entries])
      // Ghost text suggestion: 检测 agent 回复中是否包含问句
      if (autofillEnabledRef.current && inputModeRef.current === 'chat') {
        const genId = ++autofillGenRef.current
        const contextStr = messagesRef.current.slice(-6).map(m => `[${m.role}]: ${m.content.slice(0, 200)}`).join("\n")
        autofillManagerRef.current.generateSuggestion(text, contextStr).then(suggestion => {
          if (suggestion && genId === autofillGenRef.current) {
            setGhostText(suggestion.text)
            // 投机执行：后台 fork 只读 sub-agent 预执行预测输入
            if (buildSystemSegments) {
              lastSpeculationTextRef.current = suggestion.text
              speculativeRunner.startSpeculation(suggestion.text, {
                tools: toolMap,
                buildSystemSegments,
                canUseTool: (toolName, input, isWrite) =>
                  speculativeRunner.defaultCanUseTool(toolName, input, isWrite),
              })
            }
          }
        }).catch(() => {})
      }
    })

    on('message', ({ role, content }: { role: ChatMessage['role']; content: string }) => {
      setMessages(prev => [...prev, { id: nextId(), role, content }])
      refreshGoalText()
      // Ghost text suggestion: agent 回复后尝试生成输入建议
      if (role === 'agent' && autofillEnabledRef.current && inputModeRef.current === 'chat') {
        const genId = ++autofillGenRef.current
        const contextStr = messagesRef.current.slice(-6).map(m => `[${m.role}]: ${m.content.slice(0, 200)}`).join('\n')
        autofillManagerRef.current.generateSuggestion(content, contextStr).then(suggestion => {
          if (suggestion && genId === autofillGenRef.current) {
            setGhostText(suggestion.text)
            // 注意：speculation 不在此处触发，由 turnEnd 事件统一触发，
            // 避免 turnEnd + message 双重触发导致竞态。
          }
        }).catch(() => {})
      }
    })

    on('toolStart', ({ callId, name, input }: { callId: string; name: string; input: unknown }) => {
      // Mail tools are internal — don't show in TUI
      if (name === 'send_mail' || name === 'check_mail') return
      setAppState(prev => prev.status ? { ...prev, status: '' } : prev)
      setTurnTools(prev => [...prev, { id: callId, name, input, output: '', isError: false, isPending: true }])
    })

    on('turnToolReset', () => {
      const currentTools = turnToolsRef.current
      const explorationTools = currentTools.filter(t => EXPLORATION_TOOLS.has(t.name) && !t.isPending)

      if (explorationTools.length > 0) {
        const readCount = explorationTools.filter(t => t.name === 'read_file').length
        const searchCount = explorationTools.filter(t => t.name === 'glob' || t.name === 'grep').length
        const listCount = explorationTools.filter(t => t.name === 'list_dir').length
        const anyError = explorationTools.some(t => t.isError)
        const msgId = nextId()
        setMessages(prev => [...prev, {
          id: msgId,
          role: 'system',
          content: '',
          explorationSummary: { readCount, searchCount, listCount, tools: explorationTools, anyError },
        }])
      }

      setTurnTools(prev => prev.filter(t => t.isPending))
    })

    on('compacting', ({ state, detail }: { state: 'start' | 'done' | 'micro'; detail?: string }) => {
      if (state === 'start') return
      if (state === 'micro') {
        setTimeout(() => setAppState(prev => prev.compactingState === 'micro' ? { ...prev, compactingState: 'idle' } : prev), 3000)
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `✦ microcompact  ${detail ?? ''}` }])
        return
      }
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `✦ 上下文已压缩  ${detail ?? ''}` }])
    })

    on('editDiff', ({ filePath, lines, additions, removals }: { filePath: string; lines: DiffLine[]; additions: number; removals: number }) => {
      const id = nextId()
      setEditDiffs(prev => [...prev, { id, filePath, lines, additions, removals }])
      setMessages(prev => [...prev, { id, role: 'tool', content: `◀ Edited ${filePath} (${additions} added, ${removals} removed)` }])
    })

    on('toolEnd', ({ callId, name, input, output }: { callId: string; name: string; input: unknown; output: string }) => {
      const isError = /^Error:/i.test(output) || /^Permission denied/i.test(output)

      if (EXPLORATION_TOOLS.has(name)) {
        setTurnTools(prev => prev.map(p =>
          p.id === callId ? { ...p, isPending: false, output, isError } : p
        ))
        return
      }

      setTurnTools(prev => prev.filter(p => p.id !== callId))

      if (name === 'edit_file') return
      if (name === 'ask_user' || name === 'ask_user_choice') return
      if (name === 'send_mail' || name === 'check_mail') return

      setMessages(prev => [...prev, {
        id: callId,
        role: 'tool',
        content: '',
        toolCall: { name, input, output, isError },
      }])
    })

    on('recall', (memory: string) => {
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `[recalled memory]
${memory}` }])
    })

    on('subAgentDelta', ({ name, delta }: { name: string; delta: string }) => {
      setTurnTools(prev => prev.map(p => {
        if (p.name === 'agent' && (p.input as Record<string, unknown>)?.agent === name)
          return { ...p, liveOutput: (p.liveOutput ?? '') + delta, isHeartbeating: false }
        if (p.name === 'run_workflow' && p.isPending) {
          // workflow:wf_xxx → phase/log 进度（已格式化，直接追加）
          // workflow:label  → 子 agent 流式输出（加缩进区分）
          const isPhaseLog = name.match(/^workflow:wf_/)
          const line = isPhaseLog ? delta : `  ${delta}`
          return { ...p, liveOutput: (p.liveOutput ?? '') + line, isHeartbeating: false }
        }
        return p
      }))
    })

    on('subAgentHeartbeat', ({ name }: { name: string; elapsedMs: number }) => {
      setTurnTools(prev => prev.map(p =>
        (p.name === 'agent' && (p.input as Record<string, unknown>)?.agent === name) ||
        (p.name === 'run_workflow' && p.isPending)
          ? { ...p, isHeartbeating: true }
          : p
      ))
    })

    on('todoPlanUpdate', (snapshot: TodoPlanSnapshot | null) => {
      if (snapshot && snapshot.isComplete) {
        if (!todoSnapshotEmittedRef.current) {
          todoSnapshotEmittedRef.current = true
          const lines: string[] = []
          lines.push(`📋 ${snapshot.description}  (${snapshot.progress})`)
          for (const task of snapshot.tasks) {
            const icon = TODO_STATUS_ICON[task.status]
            lines.push(`  ${icon} ${task.description}${task.error ? ` — ${task.error}` : ''}`)
          }
          if (snapshot.allDone) {
            lines.push('✅ All tasks completed.')
          } else if (snapshot.hasFailure) {
            lines.push('⚠ Some tasks failed.')
          }
          pendingTodoSnapshotRef.current = lines.join('\n')
        }
      } else if (snapshot && !snapshot.isComplete) {
        todoSnapshotEmittedRef.current = false
      } else {
        todoSnapshotEmittedRef.current = false
      }
    })

    on('permission', ({ prompt, resolve }: PermissionEvent) => {
      setPromptText(prompt)
      setPermissionChoice(0)
      setInputMode('permission')
      pendingResolveRef.current = resolve as (v: any) => void
    })

    on('question', ({ prompt, resolve }: QuestionEvent) => {
      setPromptText(prompt)
      setInputMode('question')
      pendingResolveRef.current = resolve
      // ask_user 中镇压 ghost text suggestion
      setGhostText(null)
      speculativeRunner.discard()
      lastSpeculationTextRef.current = null
    })

    on('choice', ({ questions, resolve }: ChoiceEvent) => {
      // ask_user_choice 中镇压 ghost text suggestion
      setGhostText(null)
      speculativeRunner.discard()
      lastSpeculationTextRef.current = null
      setChoiceQuestions(questions)
      setChoiceSelections(questions.map(() => 0))
      setChoiceFocus(0)
      setChoiceCustomActive(null)
      setChoiceCustomInput('')
      setChoiceCustomValues({})
      setInputMode('choice')
      pendingResolveRef.current = resolve as (v: any) => void
    })

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [bridge, nextId, setAppState, setMessages])

  // Esc: cancels current request + stops any ongoing TTS playback
  // 注意：permission/choice 模式中 Esc 已有自己的处理（拒绝/取消），
  // 但它们和本 handler 不冲突 —— 双方都会触发，行为叠加合理。
  // teammateView 模式下不触发，由 TeammateConversationView 自己的 useInput 处理。
  useInput((_input, key) => {
    if (!key.escape) return
    if (appMode === 'teammateView') return
    ttsService.stop()
    if (isProcessingRef.current) {
      abortControllerRef.current?.abort()
    }
  })

  // Ctrl+E: stop TTS playback only (does NOT abort agent REPL)
  useInput((input, key) => {
    if (appMode === 'teammateView') return
    if (!key.ctrl || input !== 'e') return
    ttsService.stop()
    showHint('TTS stopped.')
  })

  // Shift+Tab: cycle agent mode (default → auto → plan → default)
  useInput((_input, key) => {
    if (appMode === 'teammateView') return
    if (!key.tab || !key.shift) return
    const next = bridge.cycleMode()
    const labels: Record<string, string> = {
      default: 'Default mode — manual permission prompts.',
      auto: 'Auto mode ON — permissions handled by AI agent.',
      plan: 'Plan mode ON — exploration and planning only, no code changes.',
    }
    showHint(labels[next] || `Mode: ${next}`)
  })

  // Ctrl+O: toggle expanded view of all tool outputs (Claude Code parity).
  useInput((input, key) => {
    if (appMode === 'teammateView') return
    if (!key.ctrl || input !== 'o') return
    setExpandAll(prev => {
      const next = !prev
      showHint(next ? 'Tool outputs expanded — Ctrl+O to collapse.' : 'Tool outputs collapsed.')
      return next
    })
  })

  // Ctrl+L: toggle MCP stdio log panel
  useInput((input, key) => {
    if (appMode === 'teammateView') return
    if (!key.ctrl || input !== 'l') return
    setShowMcpStdioLogs(prev => {
      const next = !prev
      showHint(next ? 'MCP stdio logs visible — Ctrl+L to hide.' : 'MCP stdio logs hidden.')
      return next
    })
  })

  // Ctrl+B: background the current running task (forks the agent loop).
  useInput((input, key) => {
    if (appMode === 'teammateView') return
    if (!key.ctrl || input !== 'b') return
    if (!isProcessingRef.current) {
      showHint('No running task to background.')
      return
    }
    bgControllerRef.current?.abort()
    showHint('Task moved to background — Ctrl+O to see tool details.')
  }, { isActive: isProcessing })

  // Ctrl+T: toggle Background Tasks dialog (teammate status panel).
  useInput((input, key) => {
    if (!key.ctrl || input !== 't') return
    if (appMode === 'main') {
      setAppMode('backgroundTasks')
      setDialogSelectedIndex(0)
    } else if (appMode === 'backgroundTasks') {
      setAppMode('main')
    }
    // teammateView 模式下 Ctrl+T 无操作
  })

  // Ctrl+W: toggle Workflows dialog
  useInput((input, key) => {
    if (!key.ctrl || input !== 'w') return
    if (appMode === 'main') {
      setWorkflowRuns(workflowRegistry.list())
      setWorkflowSelectedIndex(0)
      setWorkflowDialogView('list')
      setAppMode('workflowsDialog')
    } else if (appMode === 'workflowsDialog') {
      setAppMode('main')
    }
  })

  // Workflows dialog navigation (↑/↓/Enter/←/Esc)
  useInput((input, key) => {
    if (appMode !== 'workflowsDialog') return
    // 刷新数据
    setWorkflowRuns(workflowRegistry.list())
    if (key.escape || key.leftArrow || (key.ctrl && input === 'w')) {
      if (workflowDialogView === 'detail') {
        setWorkflowDialogView('list')
      } else {
        setAppMode('main')
      }
    } else if (key.upArrow) {
      setWorkflowSelectedIndex(i => Math.max(0, i - 1))
    } else if (key.downArrow) {
      setWorkflowSelectedIndex(i => Math.min(workflowRuns.length - 1, i + 1))
    } else if (key.return && workflowDialogView === 'list' && workflowRuns.length > 0) {
      setWorkflowDialogView('detail')
    }
  }, { isActive: appMode === 'workflowsDialog' })

  // Background Tasks dialog navigation (↑/↓/Enter/f/x/Esc/←)
  useInput((input, key) => {
    if (appMode !== 'backgroundTasks') return
    if (key.escape || key.leftArrow) {
      setAppMode('main')
      return
    }
    if (key.upArrow) {
      setDialogSelectedIndex(i => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setDialogSelectedIndex(i => Math.min(teammateTasks.length - 1, i + 1))
      return
    }
    if (key.return) {
      setAppMode('main')
      return
    }
    if (input === 'f') {
      const task = teammateTasks[dialogSelectedIndex]
      if (task) {
        setSelectedTeammateId(task.agentId)
        setAppMode('teammateView')
      }
      return
    }
    if (input === 'x') {
      const task = teammateTasks[dialogSelectedIndex]
      if (task) {
        // 禁止对已完成的 teammate 发 close（它们已经停止了）
        if (task.status === 'completed' || task.status === 'failed' || task.status === 'killed') {
          showHint(`Teammate already ${task.status}.`)
          return
        }
        setAppMode('main')
        const closeMsg = `用 send_mail(kind=close, to="${task.agentId}", subject="terminated", body="Terminated by user from Background Tasks dialog.") 终止这个 teammate。`
        enqueueUserMessage(closeMsg)
      }
      return
    }
  }, { isActive: appMode === 'backgroundTasks' })

  // Teammate view keyboard is now handled by TeammateConversationView's own useInput

  // Permission mode: ↑/↓ navigate, Enter confirm, Esc = no
  useInput((input, key) => {
    const answers: PermissionAnswer[] = ['yes', 'session', 'no']
    if (key.upArrow) {
      setPermissionChoice(c => ((c + 2) % 3) as 0 | 1 | 2)
      return
    }
    if (key.downArrow) {
      setPermissionChoice(c => ((c + 1) % 3) as 0 | 1 | 2)
      return
    }
    if (key.return) {
      pendingResolveRef.current?.(answers[permissionChoice])
      pendingResolveRef.current = null
      setInputMode('chat')
      setPromptText('')
      return
    }
    if (key.escape) {
      pendingResolveRef.current?.('no' satisfies PermissionAnswer)
      pendingResolveRef.current = null
      setInputMode('chat')
      setPromptText('')
      return
    }
    // 保留快捷字母键
    const map: Record<string, PermissionAnswer> = { y: 'yes', Y: 'yes', a: 'session', A: 'session', n: 'no', N: 'no' }
    if (map[input]) {
      pendingResolveRef.current?.(map[input])
      pendingResolveRef.current = null
      setInputMode('chat')
      setPromptText('')
    }
  }, { isActive: inputMode === 'permission' })

  // Choice mode: ↑/↓ navigate rows, ←/→ change option / switch button, Enter submit/cancel, Esc cancel
  useInput((_input, key) => {
    const totalRows = choiceQuestions.length + 2 // questions + Submit + Cancel
    const submitRow = choiceQuestions.length
    const cancelRow = choiceQuestions.length + 1

    // ── 辅助函数 ──────────────────────────────────────────────────────
    /** 某个问题的有效选项数（含虚拟 "Other…" 项） */
    function optCount(qi: number): number {
      const q = choiceQuestions[qi]
      return q.options.length + (q.allowOther ? 1 : 0)
    }
    /** 当前选中是否为 "Other…" */
    function isOther(qi: number): boolean {
      const q = choiceQuestions[qi]
      return !!(q.allowOther && choiceSelections[qi] === q.options.length)
    }
    /** 获取某个问题的最终答案值 */
    function answerFor(qi: number): string {
      const q = choiceQuestions[qi]
      if (isOther(qi)) return `__other__:${choiceCustomValues[qi] ?? ''}`
      return q.options[choiceSelections[qi]].value
    }

    const finish = (result: ChoiceResult) => {
      pendingResolveRef.current?.(result)
      pendingResolveRef.current = null
      setInputMode('chat')
      setChoiceQuestions([])
      setChoiceSelections([])
      setChoiceFocus(0)
      setChoiceCustomActive(null)
      setChoiceCustomInput('')
      setChoiceCustomValues({})
    }

    // ── 自定义文本输入模式 ────────────────────────────────────────────
    if (choiceCustomActive !== null) {
      if (_input && !key.escape && !key.return && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab) {
        setChoiceCustomInput(prev => prev + _input)
        return
      }
      if (key.backspace || (key.ctrl && _input === 'h')) {
        setChoiceCustomInput(prev => prev.slice(0, -1))
        return
      }
      if (key.return) {
        setChoiceCustomValues(prev => ({ ...prev, [choiceCustomActive]: choiceCustomInput }))
        setChoiceCustomActive(null)
        setChoiceCustomInput('')
        return
      }
      if (key.escape) {
        setChoiceCustomActive(null)
        setChoiceCustomInput('')
        return
      }
      return // 其他按键在输入模式下忽略
    }

    if (key.escape) {
      finish({ status: 'cancelled' })
      return
    }

    if (key.upArrow) {
      setChoiceFocus(f => (f - 1 + totalRows) % totalRows)
      return
    }
    if (key.downArrow) {
      setChoiceFocus(f => (f + 1) % totalRows)
      return
    }

    // 焦点在问题行：←/→ 切换选项
    if (choiceFocus < choiceQuestions.length) {
      const count = optCount(choiceFocus)
      if (key.leftArrow) {
        setChoiceSelections(prev => {
          const next = [...prev]
          next[choiceFocus] = (next[choiceFocus] - 1 + count) % count
          return next
        })
        return
      }
      if (key.rightArrow) {
        setChoiceSelections(prev => {
          const next = [...prev]
          next[choiceFocus] = (next[choiceFocus] + 1) % count
          return next
        })
        return
      }
      if (key.return) {
        if (isOther(choiceFocus)) {
          setChoiceCustomActive(choiceFocus)
          setChoiceCustomInput('')
        } else {
          setChoiceFocus(submitRow)
        }
        return
      }
    } else {
      // 焦点在按钮行：←/→ 在 Submit/Cancel 间切换
      if (key.leftArrow || key.rightArrow) {
        setChoiceFocus(f => f === submitRow ? cancelRow : submitRow)
        return
      }
      if (key.return) {
        if (choiceFocus === submitRow) {
          const answers: Record<string, string> = {}
          choiceQuestions.forEach((_q, i) => { answers[_q.id] = answerFor(i) })
          finish({ status: 'submitted', answers })
        } else {
          finish({ status: 'cancelled' })
        }
        return
      }
    }
  }, { isActive: inputMode === 'choice' })

  // ── 主要键盘处理：历史浏览 + 命令补全 ────────────────────────────────
  const hasSuggestions = suggestions.length > 0
  useInput((_input, key) => {
    // teammateView 模式下由 TeammateConversationView 独立处理键盘
    if (appMode === 'teammateView') return
    // 只在聊天模式、非处理状态下生效
    if (inputMode !== 'chat' || isProcessing) return

    // ── 有建议列表时的处理 ──
    if (hasSuggestions) {
      // Escape → 关闭建议列表
      if (key.escape) {
        clearSuggestions()
        return
      }

      // 上/下 → 导航建议
      if (key.upArrow) {
        setSelectedSuggestionIndex(prev => Math.max(0, prev - 1))
        return
      }
      if (key.downArrow) {
        setSelectedSuggestionIndex(prev => Math.min(suggestions.length - 1, prev + 1))
        return
      }

      // Tab → 接受当前选中的建议
      if (key.tab) {
        acceptSuggestion()
        return
      }

      // 右箭头 → 也接受建议
      if (_input === '' && key.rightArrow) {
        acceptSuggestion()
        return
      }
    }

    // ── 无建议列表：历史浏览 ──
    if (key.upArrow && inputHistory.length > 0) {
      // 第一次按 ↑，先把当前草稿存起来，后续从底部回来时还原
      if (historyIndexRef.current === -1) {
        setDraftBeforeHistory(inputValue)
      }
      const newIndex = historyIndexRef.current === -1
        ? inputHistory.length - 1
        : Math.max(0, historyIndexRef.current - 1)
      setHistoryIndex(newIndex)
      setInputValue(inputHistory[newIndex])
      return
    }
    if (key.downArrow) {
      if (historyIndexRef.current === -1) return
      const newIndex = historyIndexRef.current + 1
      if (newIndex >= inputHistory.length) {
        setHistoryIndex(-1)
        setInputValue(draftBeforeHistory ?? '')
        setDraftBeforeHistory(null)
      } else {
        setHistoryIndex(newIndex)
        setInputValue(inputHistory[newIndex])
      }
      return
    }

    // Ctrl+U: 清空当前输入
    if (key.ctrl && _input === 'u') {
      setInputValue('')
      setHistoryIndex(-1)
      setDraftBeforeHistory(null)
      clearSuggestions()
      return
    }

    // Ctrl+G: toggle ghost text autofill
    if (key.ctrl && _input === 'g') {
      const enabled = autofillManagerRef.current.toggle()
      setAutofillEnabled(enabled)
      if (!enabled) {
        setGhostText(null)
        speculativeRunner.discard()
        lastSpeculationTextRef.current = null
        showHint('Ghost text: OFF')
      } else {
        showHint('Ghost text: ON (Tab to accept)')
      }
      return
    }

    // Tab: 接受 ghost text 建议
    if (key.tab && ghostText) {
      setInputValue(ghostText)
      setGhostText(null)
      return
    }
  }, { isActive: inputMode === 'chat' && !isProcessing })

  // Sub-agent panel keyboard nav has been removed — the compact single-line
  // status in Footer is now read-only (Claude Code style).

  // ── 补全辅助函数 ──────────────────────────────────────────────────

  function clearSuggestions() {
    setSuggestions([])
    setSelectedSuggestionIndex(0)
    setAtToken(null)
  }

  function updateSuggestions(value: string) {
    if (value.startsWith('/')) {
      const partial = value.slice(1)
      const matches = commandParser.search(partial)
      setSuggestions(matches)
      setSelectedSuggestionIndex(0)
      setAtToken(null)
    } else {
      clearSuggestions()
    }
  }

  /** 异步获取 @ 文件路径建议，用于防抖竞态控制 */
  async function updateFileSuggestions(value: string, cursor: number) {
    const token = extractAtToken(value, cursor)
    if (!token || token.pathPrefix.length > 200) {
      // No valid @token or path too long — clear file suggestions
      if (atToken) clearSuggestions()
      return
    }

    // Skip if the entire input starts with @ followed by space (teammate mention)
    // and the @token is the first token
    if (token.tokenStart === 0 && value.includes(' ', token.tokenEnd)) {
      if (atToken) clearSuggestions()
      return
    }

    const checkId = value + '|' + cursor
    pendingFileSuggestRef.current = checkId

    const fileResults = await getFileSuggestions(token.pathPrefix, process.cwd())

    // Race condition check
    if (pendingFileSuggestRef.current !== checkId) return

    if (fileResults.length > 0) {
      const mapped: Suggestion[] = fileResults.map(f => ({
        name: f.name,
        description: f.kind === 'directory' ? 'directory' : 'file',
        usage: f.atPath,
      }))
      setSuggestions(mapped)
      setSelectedSuggestionIndex(0)
      setAtToken({ start: token.tokenStart, end: token.tokenEnd })
    } else {
      clearSuggestions()
    }
  }

  function acceptSuggestion() {
    const selected = suggestions[selectedSuggestionIndex]
    if (!selected) return

    if (atToken) {
      // File path completion: replace the @token with selected path
      const newValue = applyFileCompletion(
        inputValue,
        atToken.start,
        atToken.end,
        selected.usage, // usage field holds the full @path
      )
      setInputValue(newValue)
      // Set cursor after the completed path
      setCursorOffset(atToken.start + selected.usage.length)
      clearSuggestions()
    } else {
      // Command completion
      setInputValue('/' + selected.name + ' ')
      clearSuggestions()
    }
  }

  // ── 快速预检：输入中是否包含疑似文件路径（同步，无 I/O） ────────

  function looksLikeFilePath(value: string): boolean {
    return value.split(/\s+/).some(token => {
      if (token.length < 2 || token.startsWith('@')) return false
      const stripped = token.replace(/^['"]|['"]$/g, '')
      return /^(\/|~\/|\.\/|\.\.\/)/.test(stripped)
    })
  }

  // ── 附件解析（仅当输入包含 @ 时） ─────────────────────────────

  async function parseAttachmentsFromInput(value: string) {
    if (!value.includes('@') || value.trim().startsWith('/') || value.trim().startsWith('!')) {
      setAttachments([])
      setAttachmentErrors([])
      return
    }

    try {
      const { cleaned, attachments: newAtts, errors: newErrors } = await parseAttachments(value)
      setAttachments(newAtts)
      setAttachmentErrors(newErrors)
    } catch {
      // 解析中的临时异常忽略
    }
  }

  // ── 输入变化 ──────────────────────────────────────────────────────

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value)
    updateSuggestions(value)
    // 用户输入与上次 speculation 不同 → 丢弃投机执行
    if (value && lastSpeculationTextRef.current && value !== lastSpeculationTextRef.current) {
      speculativeRunner.discard()
      lastSpeculationTextRef.current = null
    }
    // 用户开始输入 → 清除 ghost text
    if (value && ghostText) {
      setGhostText(null)
    }

    // 记录当前 value，后续异步回调据此判断是否已过期
    pendingAttachmentCheckRef.current = value

    // @ 文件路径补全：异步获取建议
    if (value.includes('@') && !value.startsWith('/') && !value.startsWith('!')) {
      void updateFileSuggestions(value, cursorOffsetRef.current)
    } else if (!value.includes('@') && atToken) {
      clearSuggestions()
    }

    // 快速预检：只有包含 @ 或疑似文件路径时才做异步 I/O
    if (value.includes('@') || looksLikeFilePath(value)) {
      autoPrefixAttachments(value).then(processed => {
        // 如果 value 已变更（用户继续输入了），丢弃本次结果防竞态
        if (pendingAttachmentCheckRef.current !== value) return
        if (processed !== value) {
          setInputValue(processed)
          updateSuggestions(processed)
          if (processed.includes('@') && !processed.startsWith('/') && !processed.startsWith('!')) {
            void updateFileSuggestions(processed, cursorOffsetRef.current)
          }
        }
        parseAttachmentsFromInput(processed)
      })
    } else {
      setAttachments([])
      setAttachmentErrors([])
    }
  }, [atToken, ghostText])

  const addToHistory = useCallback((text: string) => {
    setInputHistory(prev => {
      if (!text || prev[prev.length - 1] === text) return prev
      const next = [...prev, text]
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next
    })
  }, [])

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return

    if (inputMode === 'question') {
      pendingResolveRef.current?.(trimmed)
      pendingResolveRef.current = null
      setInputMode('chat')
      setPromptText('')
      setInputValue('')
      setGhostText(null)
      return
    }

    // ── @teammate-name 直接发邮件 ────────────────────────────────────
    // 语法：@teammate-name 消息内容
    // 匹配已知 teammate 时直接发送 task 邮件，绕过 LLM
    // 不匹配时保留原文，走正常 LLM 处理（跳过附件解析，避免 @mention 被误判为文件路径）
    let skipAttachmentParsing = false
    if (trimmed.startsWith('@') && inputMode === 'chat') {
      const spaceIdx = trimmed.indexOf(' ')
      const mention = spaceIdx > 1 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)
      const body = spaceIdx > 1 ? trimmed.slice(spaceIdx + 1).trim() : ''

      const matchedTeammate = teammateTasks.find(
        t => t.agentId === mention && (t.status === 'running' || t.status === 'idle')
      )

      if (matchedTeammate && body) {
        // 防并发（和下方 submittingRef 逻辑一致）
        if (submittingRef.current) return
        submittingRef.current = true
        setInputValue('')
        setHistoryIndex(-1)
        clearSuggestions()
        addToHistory(trimmed)

        const from = mode === 'teammate' && teammateAgentId ? teammateAgentId : 'main'
        const mail = Mailbox.send({
          from,
          to: mention,
          subject: body.slice(0, 80),
          kind: 'task',
          body,
        })

        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'user',
          content: `@${mention} ${body}`,
        }, {
          id: nextId(),
          role: 'system',
          content: `📨 → @${mention}: task sent («${body.slice(0, 60)}${body.length > 60 ? '…' : ''}»)`,
        }])

        submittingRef.current = false
        return
      }
      // 不匹配已知 teammate → 保留原始文本走 LLM 处理，不走附件解析
      skipAttachmentParsing = true
    }

    // 防止 handleSubmit 并发（仅防重复点击 Enter）
    if (submittingRef.current) return

    submittingRef.current = true
    setInputValue('')
    setHistoryIndex(-1)
    clearSuggestions()

    try {
      // ! 命令：走 agent 层的 BashTool（和 LLM 调用的同个工具），不走 LLM
      if (trimmed.startsWith('!')) {
        // ! 命令处理中不允许执行
        if (isProcessingRef.current) {
          submittingRef.current = false
          return
        }

        const cmd = trimmed.slice(1).trim()
        if (!cmd) {
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '! 后面需要跟要执行的命令' }])
          submittingRef.current = false
          return
        }
        addToHistory(trimmed)
        setMessages(prev => [...prev, { id: nextId(), role: 'user', content: trimmed }])
        setIsProcessing(true)
        const bashCallId = `local-bash-${nextId()}`
        setTurnTools(prev => [...prev, { id: bashCallId, name: 'bash', input: { command: cmd }, output: '', isError: false, isPending: true }])

        try {
          const output = await runBash(cmd)
          const text = output || '(empty output)'
          const isError = /^Error:/i.test(text)
          // Remove from turnTools immediately (same as toolEnd for non-exploration tools)
          setTurnTools(prev => prev.filter(p => p.id !== bashCallId))
          setMessages(prev => [...prev, {
            id: bashCallId,
            role: 'tool',
            content: '',
            toolCall: { name: 'bash', input: { command: cmd }, output: text, isError },
          }])
          if (text.length > 2000) console.log(`[!] ${cmd}\n${text}`)
        } catch (err: any) {
          const text = `Error: ${err.message ?? err}`
          // Remove from turnTools immediately (same as toolEnd for non-exploration tools)
          setTurnTools(prev => prev.filter(p => p.id !== bashCallId))
          setMessages(prev => [...prev, {
            id: bashCallId,
            role: 'tool',
            content: '',
            toolCall: { name: 'bash', input: { command: cmd }, output: text, isError: true },
          }])
        } finally {
          setIsProcessing(false)
          submittingRef.current = false
        }
        return
      }

      if (commandParser.isCommand(trimmed)) {
        // 只读命令（状态查看类）在处理中也允许执行
        const READ_ONLY_COMMANDS = ['workflows', 'bg', 'help', 'model', 'advisor']
        const cmdName = trimmed.slice(1).split(' ')[0]
        const isReadOnly = READ_ONLY_COMMANDS.includes(cmdName)

        if (isProcessingRef.current && !isReadOnly) {
          submittingRef.current = false
          return
        }
        addToHistory(trimmed)
        await commandParser.dispatch(trimmed)
        submittingRef.current = false
        return
      }

      addToHistory(trimmed)

    // ── 投机执行：检查是否匹配上次预测 ──────────────────────────────
      const specText = lastSpeculationTextRef.current
      if (specText && trimmed === specText) {
        lastSpeculationTextRef.current = null
        const specResult = await speculativeRunner.accept()
        if (specResult) {
          const isComplete = specResult.boundary?.type === 'complete'
          if (isComplete) {
            // 投机执行已完成 → 替换 sessionState，添加结果到 TUI，跳过 LLM 调用
            sessionState.replaceMessages(specResult.messages)
            const lastAssistant = [...specResult.messages].reverse().find(m => m.role === 'assistant')
            if (lastAssistant) {
              const text = typeof lastAssistant.content === 'string'
                ? lastAssistant.content
                : lastAssistant.content.map(c => (c as any).text ?? '').join('')
              setMessages(prev => [
                ...prev,
                { id: nextId(), role: 'user', content: trimmed },
                { id: nextId(), role: 'agent', content: text || '(speculative result)' },
              ])
            } else {
              setMessages(prev => [...prev, { id: nextId(), role: 'user', content: trimmed }])
            }
            submittingRef.current = false
            setGhostText(null)
            return
          }
          // 未完成 → 切换 sub-agent 上下文到主 agent 继续执行
          // specResult.messages 已去掉 ghostText user message + 裁剪末尾，
          // 末尾是 assistant → runTurn 追加 user 是合法交替。
          sessionState.replaceMessages(specResult.messages)
          setMessages(prev => [...prev, { id: nextId(), role: 'user', content: trimmed }])
          enqueueUserMessage(trimmed)
          submittingRef.current = false
          processQueue()
          return
        }
      }

      // ── 处理附件 ──────────────────────────────────────────────────────
      // 兜底：确保裸文件路径已被 @ 前缀（防止用户在异步检测完成前按 Enter）
      // autoPrefixAttachments 对已有 @ 的 token 是 no-op，所以安全
      const safeValue = await autoPrefixAttachments(trimmed)
      let userContent: string | any[]
      let displayText = safeValue

      if (safeValue.includes('@') && !skipAttachmentParsing && !safeValue.startsWith('/') && !safeValue.startsWith('!')) {
        const { cleaned, attachments: atts, errors: attErrors } = await parseAttachments(safeValue)
        if (atts.length > 0) {
          userContent = buildUserContent(cleaned, atts)
          // 构建显示文本（含附件标记）
          const attSummary = atts.map(a => `📎 ${a.name} (${a.kind})`).join('  ')
          displayText = cleaned.trim()
            ? `${cleaned.trim()}  ${attSummary}`
            : `[attachments: ${attSummary}]`
          // 如果部分附件解析失败，附加错误到显示文本
          if (attErrors.length > 0) {
            displayText += `  ⚠ ${attErrors.join('; ')}`
          }
        } else {
          // 没有成功解析到附件 — 清理 @token 避免模型看到字面路径
          // 同时将错误加入消息内容让用户知晓
          userContent = cleaned || trimmed.replace(/@\S+/g, '').trim()
          if (!userContent) userContent = '(empty — file not found)'
          const errorMsg = attErrors.length > 0 ? `[⚠ ${attErrors.join('; ')}]` : `[⚠ file not found]`
          displayText = `${cleaned || '(empty)'}  ${errorMsg}`
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: errorMsg }])
        }
      } else {
        userContent = safeValue
      }

      setMessages(prev => [...prev, { id: nextId(), role: 'user', content: displayText }])
      setAttachments([])
      setAttachmentErrors([])

      // ── 消息队列：自然语言 prompt 入队 ──────────────────────────────
      // 用户输入 prompt → 入队 → 处理 loop 从队列消费
      // InputBox 在处理中保持可输入，用户可继续输入后续 prompt
      enqueueUserMessage(typeof userContent === 'string' ? userContent : JSON.stringify(userContent))
    } finally {
      submittingRef.current = false
    }

    // ── 从队列启动处理（submittingRef 已释放，但仍可被 isProcessing 防护） ──
    processQueue()
    // 已在处理中 → 队列中的消息会被 runAgentLoopStream 的 drainQueue 自动消费
  }

  /**
   * processQueue — 启动处理循环，从消息队列消费用户输入。
   *
   * 提取为独立函数，两个调用来源：
   *   1. handleSubmit — 用户提交输入后
   *   2. mailbox polling — idle 态检测到 teammate 来信后自动触发
   */
  const processQueue = useCallback(async () => {
    process.stderr.write(`[tui:processQueue] enter — isProcessing=${isProcessingRef.current} queueLength=${getQueueLengthRef.current()}\n`)
    if (isProcessingRef.current || getQueueLengthRef.current() === 0) {
      process.stderr.write(`[tui:processQueue] exit early (isProcessing or empty queue)\n`)
      return
    }

    isProcessingRef.current = true
    setIsProcessing(true)

    setTurnTools([])
    setAppState(prev => ({ ...prev, status: 'thinking...' }))
    turnEndedRef.current = false
    streamingRef.current = ''
    setStreamingText('')

    const ac = new AbortController()
    abortControllerRef.current = ac
    const bgAc = new AbortController()
    bgControllerRef.current = bgAc

    try {
      while (getQueueLengthRef.current() > 0 && !ac.signal.aborted) {
        const nextMsg = dequeueMessageRef.current()
        process.stderr.write(`[tui:processQueue] dequeueMessage returned: ${nextMsg ? `"${nextMsg.slice(0, 80)}..." (${nextMsg.length} chars)` : 'undefined'}\n`)
        if (!nextMsg) {
          // drainQueue consumed a mailbox-wake item (it only returns 'user' kind).
          // If there are actual unread mails, inject a trigger so runTurn starts
          // and drainMailbox picks them up during the runAgentLoopStream drain phase.
          if (hasUnreadMainMailRef.current?.()) {
            process.stderr.write(`[tui:processQueue] mailbox-wake consumed, has unread mails → injecting trigger\n`)
            turnEndedRef.current = false
            streamingRef.current = ''
            setStreamingText('')
            await runTurnRef.current('(mailbox wake — check for new messages)', ac.signal, bgAc.signal)
            continue
          }
          break
        }
        // Reset per-turn streaming state before each runTurn. turnEndedRef is set
        // to true when the previous turn's turnEnd event fires; without resetting it
        // here, text deltas from goal-feedback turns (and any subsequent queued
        // messages) would be silently dropped by the 'text' event handler.
        turnEndedRef.current = false
        streamingRef.current = ''
        setStreamingText('')
        const result = await runTurnRef.current(nextMsg, ac.signal, bgAc.signal)
        if (result && (result as any).backgrounded) {
          process.stderr.write(`[tui:processQueue] turn backgrounded, breaking loop\n`)
          break
        }
      }
    } catch (err: unknown) {
      if (!ac.signal.aborted) {
        const msg = `Error: ${err instanceof Error ? err.message + '\n' + (err.stack || '').split('\n').slice(0, 5).join('\n') : String(err)}`
        setMessages(msgs => [...msgs, { id: nextId(), role: 'system', content: msg }])
      }
    } finally {
      bgControllerRef.current = null
      const remaining = streamingRef.current
      if (remaining) {
        setMessages(msgs => [...msgs, { id: nextId(), role: 'agent', content: remaining }])
      }
      streamingRef.current = ''
      setStreamingText('')
      abortControllerRef.current = null
      isProcessingRef.current = false
      setIsProcessing(false)
      refreshGoalText()
      process.stderr.write(`[tui:processQueue] finished — isProcessing set to false\n`)
      setAppState(prev => prev.status ? { ...prev, status: '' } : prev)
    }
  }, [setMessages, setAppState, setStreamingText, nextId, refreshGoalText])
  processQueueRef.current = processQueue

  useEffect(() => {
    const cb = subscribeMainMailboxRef.current
    if (cb) {
      return cb(() => {
        process.stderr.write(`[tui:mailbox] subscribeMainMailbox fired → enqueuing mailbox-wake\n`)
        enqueueMainMailboxWakeRef.current()
      })
    }
  }, [])

  useEffect(() => {
    return subscribeQueueRef.current(() => {
      const allowedMode = mode === 'teammate' ? true : appMode === 'main'
      process.stderr.write(`[tui:queue] subscribeQueue fired — isProcessing=${isProcessingRef.current} inputMode=${inputMode} allowedMode=${allowedMode}\n`)
      if (!isProcessingRef.current && inputMode === 'chat' && allowedMode) {
        process.stderr.write(`[tui:queue] → calling processQueue()\n`)
        void processQueueRef.current()
      } else {
        process.stderr.write(`[tui:queue] → skipped (isProcessing or wrong mode)\n`)
      }
    })
  }, [inputMode, appMode])

  // ── unreadCheck debounce timer（防止 isProcessing 翻转时级联重入）──
  const unreadCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const allowedMode = mode === 'teammate' ? true : appMode === 'main'
    process.stderr.write(`[tui:unreadCheck] useEffect fired — isProcessing=${isProcessing} inputMode=${inputMode} appMode=${appMode} allowedMode=${allowedMode}\n`)
    if (isProcessing || inputMode !== 'chat' || !allowedMode) return

    // 500ms debounce：避免 processQueue 刚结束 isProcessing 翻转时立即再次触发
    if (unreadCheckTimerRef.current) clearTimeout(unreadCheckTimerRef.current)
    unreadCheckTimerRef.current = setTimeout(() => {
      unreadCheckTimerRef.current = null
      if (hasUnreadMainMailRef.current?.()) {
        process.stderr.write(`[tui:unreadCheck] hasUnreadMainMail=true → enqueuing mailbox-wake\n`)
        enqueueMainMailboxWakeRef.current()
      }
      if (getQueueLengthRef.current() > 0) {
        process.stderr.write(`[tui:unreadCheck] queue not empty (${getQueueLengthRef.current()} items) → calling processQueue\n`)
        void processQueueRef.current()
      }
    }, 500)

    return () => {
      if (unreadCheckTimerRef.current) {
        clearTimeout(unreadCheckTimerRef.current)
        unreadCheckTimerRef.current = null
      }
    }
  }, [isProcessing, inputMode, appMode])

  // ── Teammate mode: auto-start initial turn ───────────────────────────
  useEffect(() => {
    if (mode !== 'teammate' || !teammateAgentId) return
    const initMsg = `你已加入团队，开始 worker 循环。\n\n现在调用 check_mail (mode=pop) 看看邮箱里有什么。`
    setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `👂 Teammate "${teammateAgentId}" 已启动，等待任务…` }])
    // Small delay to let TUI render before enqueuing
    const t = setTimeout(() => enqueueUserMessage(initMsg), 200)
    return () => clearTimeout(t)
  }, [mode, teammateAgentId])

  // ── Teammate mode: subscribe to own mailbox for wakeups ──────────────
  useEffect(() => {
    if (mode !== 'teammate' || !teammateAgentId) return
    const unsub = Mailbox.subscribe(teammateAgentId, () => {
      if (!isProcessingRef.current) {
        enqueueUserMessage('New mail arrived — call check_mail(mode=pop) to read it.')
      }
    })
    return unsub
  }, [mode, teammateAgentId])

  // ── MCP stdio log sink ──────────────────────────────────────────────
  // 注册全局回调，替代 console.warn 输出。
  // sink 将日志写入环形缓冲区，Ctrl+L 控制是否在 TUI 中显示。
  useEffect(() => {
    setStdioLogSink((line: string) => {
      setMcpStdioLogs(prev => {
        const next = [...prev, line]
        return next.length > MAX_STDIO_LOGS ? next.slice(next.length - MAX_STDIO_LOGS) : next
      })
    })
    return () => setStdioLogSink(null)
  }, [])

  // ── 消息渲染 ────────────────────────────────────────────────────────
  // Rendering moved to MessageRow / DiffView components.

  const ctx = buildCtx(usage, MAX_CONTEXT)

  // 过滤掉 id 仍在 turnTools 中的工具消息，避免与动态区重复渲染。
  // 非探索工具在 toolEnd 时已从 turnTools 移除 -> 在 Static 正常显示。
  // 探索工具不在 messages 中有 toolCall 条目 -> 过滤器不产生影响。
  // 仅在工具刚启动尚未完成（pending）的短暂窗口内有过滤效果。
  const toolIdsInGroup = useMemo(
    () => new Set(turnTools.filter(Boolean).map(t => t.id)),
    [turnTools],
  )
  const staticMessages = useMemo(
    () => messages.filter(
      m => !(m.role === 'tool' && m.toolCall && toolIdsInGroup.has(m.id))
    ),
    [messages, toolIdsInGroup],
  )

  // 动态工具区域渲染计划：避免每帧重新构建
  const renderPlan = useMemo(
    () => buildRenderPlan(turnTools),
    [turnTools],
  )

  return (
    <ToolRenderProvider toolMap={toolMap}>
    <Box flexDirection="column">
      {/* 历史消息 + Banner，全部在动态 ink 树中渲染（对齐 Claude Code 非
          fullscreen 路径：Messages.tsx 的 renderableMessages.flatMap）。
          不使用 <Static>，因为 Static 会把内容写入终端 scrollback，与动态
          区超视口部分留下的残影一起造成"同段内容打印两次"。React.memo 在
          MessageRow 内部保证未变化的消息不重复 render。 */}
      <Banner />
      {staticMessages.map(msg => (
        <MessageRow key={msg.id} msg={msg} diffs={editDiffs} expanded={expandAll} />
      ))}

      {/* Streaming LLM response text — rendered BEFORE dynamic tools because
          the LLM's reasoning text appears chronologically before tool calls.
          When tools start, streamingText stays visible; toolEnd removes
          non-exploration tools from turnTools, so they appear directly in
          history, keeping the reading order: reasoning → tools → more
          reasoning. We display only the prefix up to the last newline so
          a half-written line doesn't keep growing the dynamic block (which
          would interact badly with re-renders). The remainder shows up
          when the next \n arrives, or all at once on turnEnd. Mirrors
          Claude Code's visibleStreamingText (REPL.tsx:1505). */}
      {streamingText ? (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="cyan">⏺ </Text>
            <Box flexDirection="column" flexGrow={1}>
              <StreamingText
                text={streamingText}
                showCursor
              />
            </Box>
          </Box>
        </Box>
      ) : null}

      {/* 动态工具区域：pending 工具（实时执行中）+ 已完成的探索工具
          （等待 turnToolReset 归档为 TurnSummary）。
          非探索工具完成时已从 turnTools 移除并直接进入 Static，
          因此不会在此区域出现再从动态"跳"到静态的过渡。 */}
      {turnTools.length > 0 ? (
        <Box flexDirection="column">
          {renderPlan.map((item, idx) => {
            if (item.type === 'summary') {
              const hasExploration = turnTools.some(t => EXPLORATION_TOOLS.has(t.name))
              if (!hasExploration) return null
              return (
                <TurnSummary
                  key="turn-summary"
                  turnTools={turnTools}
                  expanded={expandAll}
                  anyPending={turnTools.some(t => t.isPending && EXPLORATION_TOOLS.has(t.name))}
                  anyExplorationError={turnTools.some(t => !t.isPending && t.isError && EXPLORATION_TOOLS.has(t.name))}
                />
              )
            }

            // tool-group: render as individual or grouped card
            const group = item.items
            if (group.length === 1) {
              const tool = group[0]
              const isExpanded = expandAll
              if (tool.isPending) {
                return (
                  <PendingToolRow
                    key={tool.id}
                    name={tool.name}
                    input={tool.input}
                    liveOutput={tool.liveOutput}
                    isHeartbeating={tool.isHeartbeating}
                  />
                )
              }
              // Completed non-exploration tools are removed from turnTools at
              // toolEnd, so this branch is only reached for exploration tools
              // waiting for turnToolReset. No keyboard focus navigation needed.
              return (
                <ToolCallView
                  key={tool.id}
                  payload={{ name: tool.name, input: tool.input, output: tool.output, isError: tool.isError }}
                  expanded={isExpanded}
                  focused={false}
                />
              )
            }
            // Multiple consecutive same-name tools: grouped with mixed status
            return (
              <GroupedToolCallView
                key={`turn-group-${idx}`}
                name={group[0].name}
                calls={group.map(t => ({
                  id: t.id,
                  name: t.name,
                  input: t.input,
                  output: t.output,
                  isError: t.isError,
                  isPending: t.isPending,
                }))}
                anyPending={group.some(t => t.isPending)}
              />
            )
          })}
        </Box>
      ) : null}

      {/* Status spinner — only when nothing else is running */}
      {!turnTools.some(t => t.isPending) && status ? (
        <Box marginBottom={0}>
          <Spinner active elapsedSec={elapsedSec} color="cyan" />
        </Box>
      ) : null}

      {/* Compaction indicator */}
      {compactingState === 'running' ? (
        <Box marginBottom={0}>
          <Spinner active label="Compacting context" elapsedSec={elapsedSec} color="blue" showInterruptHint={false} />
        </Box>
      ) : compactingState === 'micro' ? (
        <Box marginBottom={0}>
          <Text color="blue" dimColor>✦ microcompact done</Text>
        </Box>
      ) : null}

      {/* Background Tasks Dialog (Ctrl+T) — modal overlay for teammate status */}
      {appMode === 'backgroundTasks' && (
        <BackgroundTasksDialog
          tasks={teammateTasks}
          selectedIndex={dialogSelectedIndex}
          onClose={() => setAppMode('main')}
          onKill={(agentId) => {
            setAppMode('main')
            const closeMsg = `用 send_mail(kind=close, to="${agentId}", subject="terminated", body="Terminated by user from Background Tasks dialog.") 终止这个 teammate。`
            enqueueUserMessage(closeMsg)
          }}
          onZoomIn={(agentId) => {
            setSelectedTeammateId(agentId)
            setAppMode('teammateView')
          }}
        />
      )}

      {/* Teammate Conversation View (f key from Background Tasks) */}
      {appMode === 'teammateView' && selectedTeammateId && (
        <TeammateConversationView
          teammateId={selectedTeammateId}
          task={teammateTasks.find(t => t.agentId === selectedTeammateId)}
          userId="main"
          onBack={() => setAppMode('backgroundTasks')}
        />
      )}

      {/* Workflows Dialog (Ctrl+W) — modal overlay for workflow status */}
      {appMode === 'workflowsDialog' && (
        <WorkflowsDialog
          runs={workflowRuns}
          selectedIndex={workflowSelectedIndex}
          view={workflowDialogView}
          onClose={() => setAppMode('main')}
        />
      )}

      {/* Todo List — fixed above InputBox, not scrolling with messages */}
      <TodoPanel plan={todoPlan} />

      {/* Mode-specific prompts — always mounted to avoid Ink cleanup artifacts on mode switch */}
      {inputMode !== 'permission' ? null : (
        <PermissionPrompt prompt={promptText} selected={permissionChoice} />
      )}
      {inputMode !== 'choice' ? null : (
        <ChoicePrompt
          questions={choiceQuestions}
          selections={choiceSelections}
          focus={choiceFocus}
          customActive={choiceCustomActive}
          customInput={choiceCustomInput}
          customValues={choiceCustomValues}
        />
      )}
      {(inputMode !== 'chat' && inputMode !== 'question') || appMode === 'teammateView' ? null : (
        <InputBox
          inputValue={inputValue}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isProcessing={isProcessing}
          isQuestion={inputMode === 'question'}
          questionPrompt={promptText}
          attachments={attachments}
          attachmentErrors={attachmentErrors}
          suggestions={suggestions}
          selectedSuggestionIndex={selectedSuggestionIndex}
          ghostText={ghostText ?? undefined}
          onCursorChange={handleCursorChange}
          cursorPosition={cursorOffset}
        />
      )}

      {/* MCP stdio logs — toggle with Ctrl+L */}
      {showMcpStdioLogs && mcpStdioLogs.length > 0 ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="yellow"
          paddingX={1}
          marginX={1}
          marginTop={0}
          maxHeight={8}
          overflow="hidden"
        >
          <Box>
            <Text color="yellow" bold>MCP stdio logs</Text>
            <Text color="gray" dimColor> ({mcpStdioLogs.length} lines, Ctrl+L to hide)</Text>
          </Box>
          {mcpStdioLogs.slice(-8).map((line, i) => (
            <Text key={i} color="gray" dimColor>{line}</Text>
          ))}
        </Box>
      ) : null}

      <Footer
        isProcessing={isProcessing}
        hasSuggestions={hasSuggestions}
        mode={agentMode}
        expanded={expandAll}
        ctxPercent={ctx.pct}
        ctxText={ctx.text}
        transientHint={transientHint}
        subAgentTasks={visibleTasks}
        backgroundCount={backgroundCount}
        goalText={goalText}
      />

      {mcpServers.length > 0 ? (
        <Box paddingX={1} marginTop={0}>
          <McpStatusPanel serverInfos={mcpServers} />
        </Box>
      ) : null}
    </Box>
    </ToolRenderProvider>
  )
}
