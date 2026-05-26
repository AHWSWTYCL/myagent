import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, Static, useInput, useApp } from 'ink'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { ChatMessage, ChoiceEvent, ChoiceQuestion, ChoiceResult, PermissionEvent, QuestionEvent, UsageStats } from './types.js'
import type { TuiBridge } from './bridge.js'
import type { DiffLine } from '../tools/edittool.js'
import type { CommandParser } from '../commands/commandparser.js'
import type { Suggestion } from '../commands/commandregistry.js'
import type { FileAttachment } from '../utils/attachments.js'
import { parseAttachments, buildUserContent, autoPrefixAttachments } from '../utils/attachments.js'
import { StreamingText } from './MarkdownRenderer.js'
import { Banner } from './banner.js'
import { McpStatusPanel } from './McpStatusPanel.js'
import type { MCPServerInfo } from '../mcp/mcpmanager.js'
import { MessageRow } from './MessageRow.js'
import { Spinner } from './Spinner.js'
import { PermissionPrompt, ChoicePrompt } from './Prompts.js'
import { InputBox, Footer, buildCtx } from './InputBox.js'
import { PendingToolRow, ToolCallView } from './ToolCallView.js'
import { GroupedToolCallView } from './GroupedToolCallView.js'
import { TurnSummary, EXPLORATION_TOOLS } from './TurnSummary.js'
import type { TurnToolItem } from './types.js'

type InputMode = 'chat' | 'permission' | 'question' | 'choice'

interface Props {
  bridge: TuiBridge
  commandParser: CommandParser
  runTurn: (input: string | any[], signal?: AbortSignal) => Promise<void>
  runBash: (cmd: string) => Promise<string>
}

const MAX_HISTORY = 100
const MAX_CONTEXT = 200_000

/**
 * Build a render plan that preserves the original tool call order.
 *
 * Claude Code design: no separate "exploration zone" and "non-exploration zone".
 * Instead, all tools are rendered in their natural order, with exploration
 * tools collapsed into a single TurnSummary at the position of the first one.
 *
 * Example: if LLM calls bash → read_file → bash → grep → edit
 *   plan = [
 *     { type: 'tool-group', items: [bash1] },
 *     { type: 'summary' },
 *     { type: 'tool-group', items: [bash2] },     ← NOT merged with bash1
 *     { type: 'tool-group', items: [edit1] },
 *   ]
 *
 * Consecutive same-name non-exploration tools are still grouped for display
 * (e.g. bash, bash → Bash ×2), but tools on different sides of the TurnSummary
 * boundary are NOT merged.
 */
type RenderPlanItem =
  | { type: 'summary' }
  | { type: 'tool-group'; items: TurnToolItem[] }

function buildRenderPlan(turnTools: TurnToolItem[]): RenderPlanItem[] {
  const plan: RenderPlanItem[] = []
  let explorationRendered = false
  let pendingGroup: TurnToolItem[] | null = null

  function flushGroup() {
    if (pendingGroup && pendingGroup.length > 0) {
      plan.push({ type: 'tool-group', items: pendingGroup })
      pendingGroup = null
    }
  }

  for (const tool of turnTools) {
    if (EXPLORATION_TOOLS.has(tool.name)) {
      if (!explorationRendered) {
        flushGroup()
        plan.push({ type: 'summary' })
        explorationRendered = true
      }
      // Skip individual exploration tools — TurnSummary covers them all.
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
  return plan
}

export function App({ bridge, commandParser, runTurn, runBash }: Props) {
  const { exit } = useApp()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [status, setStatus] = useState('')
  // 当前用户输入轮次内的所有工具调用。
  // 场景 B：探索工具在每个 LLM round 结束时由 turnToolReset 归档为
  // TurnSummary 静态消息并从 turnTools 移除。底部 TurnSummary 只展示
  // 当前 round 中尚未完成的探索工具。非探索工具跨 round 累积。
  const [turnTools, setTurnTools] = useState<TurnToolItem[]>([])
  const [usage, setUsage] = useState<UsageStats | null>(null)
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
  const [promptText, setPromptText] = useState('')
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [autoMode, setAutoMode] = useState(false)
  // Ctrl+O toggles full output for every tool message in the chat.
  const [expandAll, setExpandAll] = useState(false)
  const [compactingState, setCompactingState] = useState<'idle' | 'running' | 'micro'>('idle')
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
  const pendingResolveRef = useRef<((v: any) => void) | null>(null)
  const idCounter = useRef(0)
  const streamingRef = useRef('')
  const historyIndexRef = useRef(-1)
  const abortControllerRef = useRef<AbortController | null>(null)
  const isProcessingRef = useRef(false)    // 同步版 isProcessing，避免闭包过期
  const submittingRef = useRef(false)      // 防止 handleSubmit 并发

  const nextId = () => String(++idCounter.current)

  // ── Edit diff 状态 ──────────────────────────────────────────────────
  const [editDiffs, setEditDiffs] = useState<Array<{ id: string; filePath: string; lines: DiffLine[]; additions: number; removals: number }>>([])

  // ── 工具卡片键盘导航 ──────────────────────────────────────────────
  // 指向 turnTools 中已完成（!isPending）工具项的索引。-1 表示无焦点。
  // 按 Tab 在已完成工具间循环，Enter 展开/折叠输出。
  const [focusedToolIdx, setFocusedToolIdx] = useState(-1)
  // 被单独展开的工具 ID 集合（Ctrl+O 全局展开之外的细粒度控制）
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set())

  // ── 附件状态 ────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([])
  const pendingAttachmentCheckRef = useRef<string | null>(null) // 防止异步竞态

  // ── MCP 状态 ─────────────────────────────────────────────────────────
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([])

  // ── 子 agent 实时输出（路由到 pending agent tool 的 liveOutput）────

  // turnToolsRef：同步最新 turnTools，供 useEffect 中的事件回调访问
  const turnToolsRef = useRef(turnTools)
  turnToolsRef.current = turnTools

  historyIndexRef.current = historyIndex
  // 同步 ref 与 state，供 useInput/handleSubmit 使用最新值避免闭包过期
  isProcessingRef.current = isProcessing

  // ── activity (tool/status) elapsed seconds ────────────────────────
  const isActive = turnTools.some(t => t.isPending) || !!status
  useEffect(() => {
    if (!isActive) {
      setActivityStartedAt(null)
      setElapsedSec(0)
      return
    }
    setActivityStartedAt(Date.now())
    return
  }, [isActive])

  useEffect(() => {
    if (!activityStartedAt) return
    const t = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - activityStartedAt) / 1000))
    }, 250)
    return () => clearInterval(t)
  }, [activityStartedAt])

  const showHint = useCallback((text: string, ms = 2000) => {
    setTransientHint(text)
    if (transientHintTimerRef.current) clearTimeout(transientHintTimerRef.current)
    transientHintTimerRef.current = setTimeout(() => setTransientHint(''), ms)
  }, [])

  useEffect(() => {
    bridge.on('status', (msg: string) => setStatus(msg))

    let rafPending = false
    bridge.on('text', (delta: string) => {
      streamingRef.current += delta
      if (!rafPending) {
        rafPending = true
        setImmediate(() => {
          rafPending = false
          setStreamingText(streamingRef.current)
        })
      }
    })

    bridge.on('turnEnd', (text: string) => {
      if (!text) return
      setMessages(prev => [...prev, { id: nextId(), role: 'agent', content: text }])
      streamingRef.current = ''
      setStreamingText('')
    })

    bridge.on('message', ({ role, content }: { role: ChatMessage['role']; content: string }) => {
      setMessages(prev => [...prev, { id: nextId(), role, content }])
    })

    bridge.on('toolStart', ({ callId, name, input }: { callId: string; name: string; input: unknown }) => {
      setStatus('')
      // Tools are about to execute — hide streaming text from the dynamic area
      // so the display order is: user msg → tools → agent summary text.
      // The text is preserved in streamingRef and will be archived on onTurnEnd.
      setStreamingText('')
      setTurnTools(prev => [...prev, { id: callId, name, input, output: '', isError: false, isPending: true }])
    })

    bridge.on('usage', (stats: UsageStats) => {
      setUsage(stats)
    })

    bridge.on('usageReset', () => {
      setUsage(null)
    })

    // 场景 B：每个 LLM round 结束时，将本轮的探索工具归档为 TurnSummary 静态消息。
    // 多条 round = 多条 TurnSummary 出现在 Static 区域。
    // 归档后从 turnTools 中移除，底部 TurnSummary 不再展示已归档的工具。
    //
    // 注意：不依赖 isPending 过滤——toolEnd 已在 turnToolReset 之前触发，
    // 但 React state 更新是异步的，turnToolsRef.current 可能尚未反映 completed 状态。
    // 而 turnToolReset 发生时，turnTools 中的所有探索工具必然已经执行完毕，
    // 所以直接归档全部探索工具是安全的。
    bridge.on('turnToolReset', () => {
      const currentTools = turnToolsRef.current
      const explorationTools = currentTools.filter(t => EXPLORATION_TOOLS.has(t.name))
      if (explorationTools.length === 0) return

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

      // 从 turnTools 中移除所有探索工具（排除 pending 探索工具，防止 toolEnd
      // 还没到来时新工具被误删。但理论上 turnToolReset 不在此场景发生。）
      setTurnTools(prev => prev.filter(t => !EXPLORATION_TOOLS.has(t.name) || t.isPending))
    })

    bridge.on('compacting', ({ state, detail }: { state: 'start' | 'done' | 'micro'; detail?: string }) => {
      if (state === 'start') {
        setCompactingState('running')
      } else if (state === 'micro') {
        setCompactingState('micro')
        setTimeout(() => setCompactingState('idle'), 3000)
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `✦ microcompact  ${detail ?? ''}` }])
      } else {
        setCompactingState('idle')
        setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `✦ 上下文已压缩  ${detail ?? ''}` }])
      }
    })

    bridge.on('editDiff', ({ filePath, lines, additions, removals }: { filePath: string; lines: DiffLine[]; additions: number; removals: number }) => {
      const id = nextId()
      setEditDiffs(prev => [...prev, { id, filePath, lines, additions, removals }])
      setMessages(prev => [...prev, { id, role: 'tool', content: `◀ Edited ${filePath} (${additions} added, ${removals} removed)` }])
    })

    bridge.on('toolEnd', ({ callId, name, input, output }: { callId: string; name: string; input: unknown; output: string }) => {
      // Update the turnTools entry: pending → completed
      const isError = /^Error:/i.test(output) || /^Permission denied/i.test(output)
      setTurnTools(prev => prev.map(p =>
        p.id === callId ? { ...p, isPending: false, output, isError } : p
      ))
      // edit_file is rendered via editDiff (full diff). Skip the generic entry to avoid duplication.
      if (name === 'edit_file') return
      // ask_user / ask_user_choice are interactive — the prompt itself is the visible UI.
      if (name === 'ask_user' || name === 'ask_user_choice') return
      // Exploration tools (read_file/list_dir/glob/grep) are rendered by TurnSummary
      // from turnTools, not as individual messages. This matches Claude Code's
      // CollapsedReadSearchContent approach — one consolidated group per turn.
      if (EXPLORATION_TOOLS.has(name)) return
      // 使用 callId 作为消息 id，这样 <Static> 的过滤条件 (toolIdsInGroup.has(m.id))
      // 能正确匹配，避免工具在 <Static> 和 turnTools 区域中重复渲染。
      setMessages(prev => [...prev, {
        id: callId,
        role: 'tool',
        content: '',
        toolCall: { name, input, output, isError },
      }])
      setFocusedToolIdx(-1) // Reset focus when new tools arrive
    })

    bridge.on('recall', (memory: string) => {
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `[recalled memory]\n${memory}` }])
    })

    bridge.on('mcp-status', (servers: MCPServerInfo[]) => {
      setMcpServers(servers)
    })

    bridge.on('subAgentDelta', ({ name, delta }: { name: string; delta: string }) => {
      // Route sub-agent live output to the pending agent tool's liveOutput,
      // so it renders inline under the tool card header (Claude Code style).
      setTurnTools(prev => prev.map(p =>
        p.name === 'agent' && (p.input as Record<string, unknown>)?.agent === name
          ? { ...p, liveOutput: (p.liveOutput ?? '') + delta, isHeartbeating: false }
          : p
      ))
    })

    bridge.on('subAgentHeartbeat', ({ name, elapsedMs }: { name: string; elapsedMs: number }) => {
      // Show heartbeat as a subtle indicator on the pending agent tool
      setTurnTools(prev => prev.map(p =>
        p.name === 'agent' && (p.input as Record<string, unknown>)?.agent === name
          ? { ...p, isHeartbeating: true }
          : p
      ))
    })

    bridge.on('autoModeChange', (enabled: boolean) => {
      setAutoMode(enabled)
    })

    bridge.on('permission', ({ prompt, resolve }: PermissionEvent) => {
      setPromptText(prompt)
      setPermissionChoice(0)
      setInputMode('permission')
      pendingResolveRef.current = resolve as (v: any) => void
    })

    bridge.on('question', ({ prompt, resolve }: QuestionEvent) => {
      setPromptText(prompt)
      setInputMode('question')
      pendingResolveRef.current = resolve
    })

    bridge.on('choice', ({ questions, resolve }: ChoiceEvent) => {
      setChoiceQuestions(questions)
      setChoiceSelections(questions.map(() => 0))
      setChoiceFocus(0)
      setChoiceCustomActive(null)
      setChoiceCustomInput('')
      setChoiceCustomValues({})
      setInputMode('choice')
      pendingResolveRef.current = resolve as (v: any) => void
    })

    return () => { bridge.removeAllListeners() }
  }, [bridge])

  // Esc: cancels current request (only when processing)
  // 注意：permission/choice 模式中 Esc 已有自己的处理（拒绝/取消），
  // 但它们和本 handler 不冲突 —— 双方都会触发，行为叠加合理。
  useInput((_input, key) => {
    if (!key.escape) return
    if (isProcessingRef.current) {
      abortControllerRef.current?.abort()
    }
  })

  // Shift+Tab: toggle auto permission mode
  // 选 Shift+Tab 而非 Ctrl+A，因为 ink-text-input 自身已过滤 Shift+Tab，
  // 不会在输入框里误插字符，无需 hack。
  useInput((_input, key) => {
    if (!key.tab || !key.shift) return
    const next = bridge.toggleAutoMode()
    showHint(next ? 'Auto mode ON — permissions handled by AI agent.' : 'Auto mode OFF — manual permission prompts restored.')
  })

  // Ctrl+O: toggle expanded view of all tool outputs (Claude Code parity).
  useInput((input, key) => {
    if (!key.ctrl || input !== 'o') return
    setExpandAll(prev => {
      const next = !prev
      showHint(next ? 'Tool outputs expanded — Ctrl+O to collapse.' : 'Tool outputs collapsed.')
      return next
    })
  })

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

    // ── 已完成工具的键盘导航 ──────────────────────────────────────────
    // Tab/Shift+Tab: 在已完成工具间切换焦点
    // Enter: 展开/折叠输出
    // 探索类工具（read_file/list_dir/glob/grep）由 TurnSummary + Ctrl+O 统一控制，
    // 不参与单独的焦点导航。
    const nonExplorationCompleted = turnTools.filter(t => !t.isPending && !EXPLORATION_TOOLS.has(t.name))
    const toolCount = nonExplorationCompleted.length
    if (toolCount > 0) {
      // Tab → 聚焦下一个工具 / 退出焦点（循环: -1→0→1→...→last→-1）
      if (key.tab && !key.shift && !inputValue) {
        setFocusedToolIdx(prev => prev >= toolCount - 1 ? -1 : prev + 1)
        return
      }
      // Shift+Tab → 聚焦上一个工具
      if (key.tab && key.shift && !inputValue && focusedToolIdx >= 0) {
        setFocusedToolIdx(prev => (prev - 1 + toolCount) % toolCount)
        return
      }
      // Enter → 当有焦点（且 input 为空）时展开/折叠工具输出
      if (key.return && !inputValue && focusedToolIdx >= 0 && focusedToolIdx < toolCount) {
        const tool = nonExplorationCompleted[focusedToolIdx]
        setExpandedToolIds(prev => {
          const next = new Set(prev)
          if (next.has(tool.id)) next.delete(tool.id)
          else next.add(tool.id)
          return next
        })
        return
      }
    }

    // Ctrl+U: 清空当前输入
    if (key.ctrl && _input === 'u') {
      setInputValue('')
      setHistoryIndex(-1)
      setDraftBeforeHistory(null)
      clearSuggestions()
      return
    }
  }, { isActive: inputMode === 'chat' && !isProcessing })

  // ── 补全辅助函数 ──────────────────────────────────────────────────

  function clearSuggestions() {
    setSuggestions([])
    setSelectedSuggestionIndex(0)
  }

  function updateSuggestions(value: string) {
    if (value.startsWith('/')) {
      const partial = value.slice(1) // 去掉 '/'
      const matches = commandParser.search(partial)
      setSuggestions(matches)
      setSelectedSuggestionIndex(0)
    } else {
      clearSuggestions()
    }
  }

  function acceptSuggestion() {
    const selected = suggestions[selectedSuggestionIndex]
    if (!selected) return
    setInputValue('/' + selected.name + ' ')
    clearSuggestions()
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

    // 记录当前 value，后续异步回调据此判断是否已过期
    pendingAttachmentCheckRef.current = value

    // 快速预检：只有包含 @ 或疑似文件路径时才做异步 I/O
    if (value.includes('@') || looksLikeFilePath(value)) {
      autoPrefixAttachments(value).then(processed => {
        // 如果 value 已变更（用户继续输入了），丢弃本次结果防竞态
        if (pendingAttachmentCheckRef.current !== value) return
        if (processed !== value) {
          setInputValue(processed)
          updateSuggestions(processed)
        }
        parseAttachmentsFromInput(processed)
      })
    } else {
      setAttachments([])
      setAttachmentErrors([])
    }
  }, [])

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
      return
    }

    // 用 ref 检查避免闭包过期；若正在处理中或已有提交在执行，静默丢弃
    if (isProcessingRef.current || submittingRef.current) return

    submittingRef.current = true
    setInputValue('')
    setHistoryIndex(-1)
    clearSuggestions()

    try {
      // ! 命令：走 agent 层的 BashTool（和 LLM 调用的同个工具），不走 LLM
      if (trimmed.startsWith('!')) {
        const cmd = trimmed.slice(1).trim()
        if (!cmd) {
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: '! 后面需要跟要执行的命令' }])
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
          setTurnTools(prev => prev.map(p =>
            p.id === bashCallId ? { ...p, isPending: false, output: text, isError } : p
          ))
          setMessages(prev => [...prev, {
            id: bashCallId,
            role: 'tool',
            content: '',
            toolCall: { name: 'bash', input: { command: cmd }, output: text, isError },
          }])
          setFocusedToolIdx(-1)
          if (text.length > 2000) console.log(`[!] ${cmd}\n${text}`)
        } catch (err: any) {
          const text = `Error: ${err.message ?? err}`
          setTurnTools(prev => prev.map(p =>
            p.id === bashCallId ? { ...p, isPending: false, output: text, isError: true } : p
          ))
          setMessages(prev => [...prev, {
            id: bashCallId,
            role: 'tool',
            content: '',
            toolCall: { name: 'bash', input: { command: cmd }, output: text, isError: true },
          }])
          setFocusedToolIdx(-1)
        } finally {
          setIsProcessing(false)
        }
        return
      }

      if (commandParser.isCommand(trimmed)) {
        await commandParser.dispatch(trimmed)
        return
      }

      addToHistory(trimmed)

      // ── 处理附件 ──────────────────────────────────────────────────────
      // 兜底：确保裸文件路径已被 @ 前缀（防止用户在异步检测完成前按 Enter）
      // autoPrefixAttachments 对已有 @ 的 token 是 no-op，所以安全
      const safeValue = await autoPrefixAttachments(trimmed)
      let userContent: string | any[]
      let displayText = safeValue

      if (safeValue.includes('@') && !safeValue.startsWith('/') && !safeValue.startsWith('!')) {
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
      // 场景 B：探索工具已在每次 turnToolReset 时逐 round 归档为 TurnSummary
      // 静态消息。这里不再重复归档。直接清空上一轮的工具数据开始新轮次。
      setTurnTools([])
      setFocusedToolIdx(-1)
      setExpandedToolIds(new Set())
      setIsProcessing(true)
      setStatus('thinking...')
      streamingRef.current = ''
      setStreamingText('')

      const ac = new AbortController()
      abortControllerRef.current = ac

      try {
        await runTurn(userContent, ac.signal)
      } catch (err: unknown) {
        const msg = ac.signal.aborted
          ? 'Cancelled.'
          : `Error: ${err instanceof Error ? err.message + '\n' + (err.stack || '').split('\n').slice(0, 5).join('\n') : String(err)}`
        setMessages(msgs => [...msgs, { id: nextId(), role: 'system', content: msg }])
      } finally {
        const remaining = streamingRef.current
        if (remaining) {
          setMessages(msgs => [...msgs, { id: nextId(), role: 'agent', content: remaining }])
        }
        streamingRef.current = ''
        setStreamingText('')
        // turnTools 不清空——保留非探索工具的已完成展示。
        // 探索工具已在每轮 turnToolReset 时归档，不会出现在这里。
        // handleSubmit 开始时才会清空 turnTools，开始新轮次。
        abortControllerRef.current = null
        setIsProcessing(false)
        setStatus('')
      }
    } finally {
      submittingRef.current = false
    }
  }

  // ── 消息渲染 ────────────────────────────────────────────────────────
  // Rendering moved to MessageRow / DiffView components.

  const ctx = buildCtx(usage, MAX_CONTEXT)

  // 当 turnTools 中有工具卡片时，它们在下方区域显示。
  // 为避免同一工具在 Static 中重复显示，过滤掉对应 toolCall 消息。
  // 只过滤已完成（isPending=false）的工具——pending 状态的工具还没有消息可过滤。
  const toolIdsInGroup = new Set(turnTools.filter(Boolean).map(t => t.id))
  const staticMessages = messages.filter(
    m => !(m.role === 'tool' && m.toolCall && toolIdsInGroup.has(m.id))
  )

  return (
    <Box flexDirection="column">
      <Static
        key={expandAll ? 'static-expanded' : 'static-collapsed'}
        items={[{ id: "__banner__", role: "system", content: "" } as ChatMessage, ...staticMessages].filter(Boolean)}
      >
        {(msg) => {
          if (msg.id === '__banner__') return <Banner key="__banner__" />
          return <MessageRow key={msg.id} msg={msg} diffs={editDiffs} expanded={expandAll} />
        }}
      </Static>

      {/* 当前轮次的工具调用（动态区域，不在 Static 中）。
          方案 B：按 LLM 原始调用顺序渲染，TurnSummary 嵌入到第一个探索工具的位置，
          而非固定放在顶部。非探索工具跨 round 累积，在 handleSubmit 开始时清空。 */}
      {turnTools.length > 0 ? (
        <Box flexDirection="column">
          {buildRenderPlan(turnTools).map((item, idx) => {
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
              const nonExplorationCompleted = turnTools.filter(t => !t.isPending && !EXPLORATION_TOOLS.has(t.name))
              const flatIdx = nonExplorationCompleted.indexOf(tool)
              const isFocused = !tool.isPending && flatIdx >= 0 ? flatIdx === focusedToolIdx : false
              const isExpanded = expandAll || expandedToolIds.has(tool.id)
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
              return (
                <ToolCallView
                  key={tool.id}
                  payload={{ name: tool.name, input: tool.input, output: tool.output, isError: tool.isError }}
                  expanded={isExpanded}
                  focused={isFocused}
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
          {focusedToolIdx >= 0 ? (
            <Box>
              <Text color="gray" dimColor>  Tab ↑↓ navigate · Enter expand/collapse</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}

      {/* Streaming LLM response text — rendered AFTER tools because
          tools execute before the LLM generates its response. */}
      {streamingText ? (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color="cyan">⏺ </Text>
            <Box flexDirection="column" flexGrow={1}>
              <StreamingText text={streamingText} showCursor />
            </Box>
          </Box>
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

      {/* Mode-specific prompts */}
      {inputMode === 'permission' ? (
        <PermissionPrompt prompt={promptText} selected={permissionChoice} />
      ) : inputMode === 'choice' ? (
        <ChoicePrompt
          questions={choiceQuestions}
          selections={choiceSelections}
          focus={choiceFocus}
          customActive={choiceCustomActive}
          customInput={choiceCustomInput}
          customValues={choiceCustomValues}
        />
      ) : (
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
        />
      )}

      <Footer
        isProcessing={isProcessing}
        hasSuggestions={hasSuggestions}
        autoMode={autoMode}
        expanded={expandAll}
        ctxPercent={ctx.pct}
        ctxText={ctx.text}
        transientHint={transientHint}
      />

      {mcpServers.length > 0 ? (
        <Box paddingX={1} marginTop={0}>
          <McpStatusPanel serverInfos={mcpServers} />
        </Box>
      ) : null}
    </Box>
  )
}
