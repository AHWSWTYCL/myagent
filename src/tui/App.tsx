import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, Static, useInput, useApp, useWindowSize } from 'ink'
import TextInput from 'ink-text-input'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { ChatMessage, ChoiceEvent, ChoiceQuestion, ChoiceResult, PermissionEvent, QuestionEvent, UsageStats } from './types.js'
import type { TuiBridge } from './bridge.js'
import type { DiffLine } from '../tools/edittool.js'
import type { CommandParser } from '../commands/commandparser.js'
import type { Suggestion } from '../commands/commandregistry.js'
import type { FileAttachment } from '../utils/attachments.js'
import { parseAttachments, buildUserContent, autoPrefixAttachments } from '../utils/attachments.js'
import { MarkdownRenderer, StreamingText } from './MarkdownRenderer.js'
import { Banner } from './banner.js'
import { McpStatusPanel } from './McpStatusPanel.js'
import type { MCPServerInfo } from '../mcp/mcpmanager.js'

type InputMode = 'chat' | 'permission' | 'question' | 'choice'

interface Props {
  bridge: TuiBridge
  commandParser: CommandParser
  runTurn: (input: string | any[], signal?: AbortSignal) => Promise<void>
  runBash: (cmd: string) => Promise<string>
}

const ROLE_COLOR: Record<string, string> = {
  user: 'cyan',
  agent: 'white',
  tool: 'yellow',
  system: 'gray',
}

const ROLE_LABEL: Record<string, string> = {
  user: 'you  ',
  agent: 'agent',
  tool: 'tool ',
  system: '     ',
}

const MAX_HISTORY = 100
const MAX_CONTEXT = 200_000
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function App({ bridge, commandParser, runTurn, runBash }: Props) {
  const { exit } = useApp()
  const { columns } = useWindowSize()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [status, setStatus] = useState('')
  const [toolRunning, setToolRunning] = useState('')
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
  const [compactingState, setCompactingState] = useState<'idle' | 'running' | 'micro'>('idle')
  // 临时提示条（footer 上方淡出消息），不进聊天历史
  const [transientHint, setTransientHint] = useState('')
  const transientHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 历史导航前的草稿（首次按 ↑ 时暂存，回到底时还原）
  const [draftBeforeHistory, setDraftBeforeHistory] = useState<string | null>(null)
  // spinner 帧 + 当前 tool/status 开始时间
  const [spinnerFrame, setSpinnerFrame] = useState(0)
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

  // ── 附件状态 ────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([])
  const pendingAttachmentCheckRef = useRef<string | null>(null) // 防止异步竞态

  // ── MCP 状态 ─────────────────────────────────────────────────────────
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([])

  // ── 子 agent 实时输出 ────────────────────────────────────────────────
  const [subAgentOutputs, setSubAgentOutputs] = useState<Record<string, string>>({})
  const subAgentOutputsRef = useRef<Record<string, string>>({})
  const activeSubAgentRef = useRef<string | null>(null)
  // 子 agent 内静默命令的心跳：name -> { elapsedMs, lastBeatAt }。
  // lastBeatAt 用于让 TUI 在没有新心跳后自动清掉动画（命令真正结束时 BuildBashTool 会停发）。
  const [subAgentHeartbeats, setSubAgentHeartbeats] = useState<
    Record<string, { elapsedMs: number; lastBeatAt: number }>
  >({})

  historyIndexRef.current = historyIndex
  // 同步 ref 与 state，供 useInput/handleSubmit 使用最新值避免闭包过期
  isProcessingRef.current = isProcessing

  // ── spinner 帧动画 + 已用秒数 ──────────────────────────────────
  const isActive = !!toolRunning || (!!status && !toolRunning)
  useEffect(() => {
    if (!isActive) {
      setActivityStartedAt(null)
      setElapsedSec(0)
      setSpinnerFrame(0)
      return
    }
    setActivityStartedAt(Date.now())
    const tick = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length)
      // 清掉 1.5s 内没新心跳的项 —— BuildBashTool 命令一结束就停发心跳
      setSubAgentHeartbeats(prev => {
        const now = Date.now()
        let changed = false
        const next: typeof prev = {}
        for (const [k, v] of Object.entries(prev)) {
          if (now - v.lastBeatAt < 1500) next[k] = v
          else changed = true
        }
        return changed ? next : prev
      })
    }, 80)
    return () => clearInterval(tick)
  }, [isActive, toolRunning, status])

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

    bridge.on('toolStart', ({ name, summary }: { name: string; summary: string }) => {
      setToolRunning(`${name}  ${summary}`)
      setStatus('')
      // 当主 agent 调用 agent 工具时，记录当前子 agent 名，准备接收实时输出
      if (name === 'agent') {
        // summary 格式如 "agent  project_builder  (task)"
        const parts = summary.split(/\s+/)
        const agentName = parts[1] || 'sub-agent'
        activeSubAgentRef.current = agentName
        // 清空该 agent 的历史积累（重新开始）
        subAgentOutputsRef.current = { ...subAgentOutputsRef.current, [agentName]: '' }
        setSubAgentOutputs(prev => ({ ...prev, [agentName]: '' }))
      }
    })

    bridge.on('usage', (stats: UsageStats) => {
      setUsage(stats)
      setToolRunning('')
      // 子 agent 执行完毕：归档实时输出为静态系统消息
      const name = activeSubAgentRef.current
      if (name) {
        const text = subAgentOutputsRef.current[name]
        if (text) {
          setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `[${name}] 输出:\n${text.trimEnd()}` }])
        }
        // 清理
        activeSubAgentRef.current = null
        subAgentOutputsRef.current = { ...subAgentOutputsRef.current, [name]: '' }
        setSubAgentOutputs(prev => {
          const next = { ...prev }
          delete next[name]
          return next
        })
      }
    })

    bridge.on('usageReset', () => {
      setUsage(null)
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

    bridge.on('recall', (memory: string) => {
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `[recalled memory]\n${memory}` }])
    })

    bridge.on('mcp-status', (servers: MCPServerInfo[]) => {
      setMcpServers(servers)
    })

    bridge.on('subAgentDelta', ({ name, delta }: { name: string; delta: string }) => {
      // Accumulate in ref for reliable reads in other handlers
      subAgentOutputsRef.current[name] = (subAgentOutputsRef.current[name] ?? '') + delta
      // Trigger re-render for live display (throttled via React batching)
      setSubAgentOutputs(prev => ({
        ...prev,
        [name]: (prev[name] ?? '') + delta,
      }))
      // 一旦有新输出，立刻清掉该 agent 的心跳动画（不沉默了）
      setSubAgentHeartbeats(prev => {
        if (!(name in prev)) return prev
        const next = { ...prev }
        delete next[name]
        return next
      })
    })

    bridge.on('subAgentHeartbeat', ({ name, elapsedMs }: { name: string; elapsedMs: number }) => {
      setSubAgentHeartbeats(prev => ({
        ...prev,
        [name]: { elapsedMs, lastBeatAt: Date.now() },
      }))
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
      return q.allowOther && choiceSelections[qi] === q.options.length
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
        setToolRunning(`bash  ${cmd}`)

        try {
          const output = await runBash(cmd)
          const text = output || '(empty output)'
          setMessages(prev => [...prev, { id: nextId(), role: 'tool', content: text }])
          if (text.length > 2000) console.log(`[!] ${cmd}\n${text}`)
        } catch (err: any) {
          setMessages(prev => [...prev, { id: nextId(), role: 'tool', content: `Error: ${err.message ?? err}` }])
        } finally {
          setToolRunning('')
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
          : `Error: ${err instanceof Error ? err.message : String(err)}`
        setMessages(msgs => [...msgs, { id: nextId(), role: 'system', content: msg }])
      } finally {
        const remaining = streamingRef.current
        if (remaining) {
          setMessages(msgs => [...msgs, { id: nextId(), role: 'agent', content: remaining }])
        }
        streamingRef.current = ''
        setStreamingText('')
        setToolRunning('')
        abortControllerRef.current = null
        setIsProcessing(false)
        setStatus('')
      }
    } finally {
      submittingRef.current = false
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  function fmtTokens(n: number): string {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
  }

  // ── 消息渲染 ────────────────────────────────────────────────────────

  function renderMessage(msg: ChatMessage) {
    // 检查是否是 edit_file 的 diff 消息
    if (msg.role === 'tool') {
      const diff = editDiffs.find(d => d.id === msg.id)
      if (diff) {
        return (
          <Box key={msg.id} flexDirection="column">
            <Box>
              <Text color="gray">tool  </Text>
              <Text color="yellow">◀ {diff.filePath}</Text>
              <Text color="gray">  ({diff.additions} added, {diff.removals} removed)</Text>
            </Box>
            <Box paddingLeft={6} marginTop={0}>
              <DiffView lines={diff.lines} additions={diff.additions} removals={diff.removals} />
            </Box>
          </Box>
        )
      }
      return (
        <Box key={msg.id}>
          <Text color="gray">{ROLE_LABEL[msg.role]} </Text>
          <Text color={ROLE_COLOR[msg.role] as any} wrap="wrap">{msg.content}</Text>
        </Box>
      )
    }

    if (msg.role === 'system') {
      return (
        <Box key={msg.id}>
          <Text color="gray">{ROLE_LABEL[msg.role]} </Text>
          <Text color={ROLE_COLOR[msg.role] as any} wrap="wrap">{msg.content}</Text>
        </Box>
      )
    }

    return (
      <Box key={msg.id} flexDirection="column">
        <Text color="gray">{ROLE_LABEL[msg.role]} </Text>
        <Box paddingLeft={msg.role === 'agent' ? 6 : 5}>
          <MarkdownRenderer content={msg.content} />
        </Box>
      </Box>
    )
  }

  // ── 命令补全建议列表渲染 ──────────────────────────────────────────

  function renderSuggestions() {
    if (!hasSuggestions) return null

    return (
      <Box
        borderStyle="round"
        borderColor="cyan"
        marginLeft={2}
        flexDirection="column"
        paddingX={1}
        paddingY={0}
      >
        {suggestions.map((s, i) => {
          const isSelected = i === selectedSuggestionIndex
          return (
            <Box key={s.name} flexDirection="column">
              <Box>
                <Text color={isSelected ? 'cyan' : 'gray'}>
                  {isSelected ? '▸ ' : '  '}
                </Text>
                <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>
                  /{s.name}
                </Text>
                <Text color="gray">
                  {'  '}{s.description}
                </Text>
              </Box>
              {isSelected && s.usage ? (
                <Box paddingLeft={4}>
                  <Text color="gray" dimColor>usage: {s.usage}</Text>
                </Box>
              ) : null}
            </Box>
          )
        })}
      </Box>
    )
  }

  // ── Diff 渲染组件 ───────────────────────────────────────────────────

  function DiffView({ lines, additions, removals }: { lines: DiffLine[]; additions: number; removals: number }) {
    return (
      <Box flexDirection="column">
        {lines.length > 80 ? (
          // 太多行时简略展示
          <Text color="gray">  {additions} added, {removals} removed</Text>
        ) : (
          lines.map((line, i) => {
            const color = line.type === 'add' ? 'green' : line.type === 'remove' ? 'red' : 'gray'
            const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '
            const lineNum = line.type === 'remove' ? String(line.oldLine ?? '') : String(line.newLine ?? '')
            return (
              <Box key={i}>
                <Text color={color as any}>{prefix} {lineNum.padStart(3)}  {line.content}</Text>
              </Box>
            )
          })
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Static items={[{ id: '__banner__', role: 'system', content: '' } as ChatMessage, ...messages]}>
        {(msg) => {
          if (msg.id === '__banner__') {
            return <Banner key="__banner__" />
          }
          return renderMessage(msg)
        }}
      </Static>

      {streamingText ? (
        <Box flexDirection="column">
          <Text color="gray">agent </Text>
          <Box paddingLeft={6}>
            <StreamingText text={streamingText} showCursor />
          </Box>
        </Box>
      ) : null}

      {toolRunning ? (
        <Box>
          <Text color="yellow">  {SPINNER_FRAMES[spinnerFrame]} </Text>
          <Text color="yellow" dimColor>{toolRunning}</Text>
          {elapsedSec > 0 ? <Text color="gray" dimColor>{`  ${elapsedSec}s`}</Text> : null}
        </Box>
      ) : null}

      {/* 子 agent 实时输出面板 */}
      {activeSubAgentRef.current ? (
        (() => {
          const name = activeSubAgentRef.current
          const text = subAgentOutputs[name]
          const heartbeat = subAgentHeartbeats[name]
          if (!text && !heartbeat) return null
          // 取最后 20 行显示
          const lines = (text ?? '').split('\n')
          const displayLines = lines.length > 20 ? lines.slice(-20) : lines
          return (
            <Box flexDirection="column" paddingLeft={2} paddingTop={0}>
              <Text color="magenta" bold>── {name} ──</Text>
              {displayLines.map((line, i) => (
                <Text key={i} color="gray" wrap="wrap">{line}</Text>
              ))}
              {heartbeat ? (
                <Text color="cyan">
                  {SPINNER_FRAMES[spinnerFrame]} {name} still working — {Math.floor(heartbeat.elapsedMs / 1000)}s
                </Text>
              ) : null}
              <Text color="magenta" dimColor>── {name} (running {elapsedSec}s) ──</Text>
            </Box>
          )
        })()
      ) : null}

      {status && !toolRunning ? (
        <Box>
          <Text color="gray" dimColor>  {SPINNER_FRAMES[spinnerFrame]} {status}</Text>
          {elapsedSec > 0 ? <Text color="gray" dimColor>{`  ${elapsedSec}s`}</Text> : null}
        </Box>
      ) : null}

      {compactingState === 'running' ? (
        <Box>
          <Text color="blue">  {SPINNER_FRAMES[spinnerFrame]} </Text>
          <Text color="blue">compacting context...</Text>
        </Box>
      ) : compactingState === 'micro' ? (
        <Box>
          <Text color="blue" dimColor>  ✦ microcompact done</Text>
        </Box>
      ) : null}

      {/* Input box */}
      <Box
        borderStyle="single"
        borderColor={inputMode !== 'chat' ? 'yellow' : inputValue.startsWith('!') ? 'green' : isProcessing ? 'gray' : 'cyan'}
        paddingX={1}
        flexDirection="column"
      >
        <Box flexDirection="column">
          {inputMode === 'permission' ? (
            <Box flexDirection="column">
              <Text color="yellow">{promptText}</Text>
              {(['Yes, just this once', 'Yes, allow for the rest of session', 'No'] as const).map((label, i) => {
                const sel = i === permissionChoice
                return (
                  <Text key={i} color={sel ? 'cyan' : 'gray'} bold={sel}>
                    {sel ? '▸ ' : '  '}{i + 1}. {label}
                  </Text>
                )
              })}
              <Text color="gray" dimColor>↑↓ navigate  Enter confirm  Esc cancel  (y/a/n shortcuts)</Text>
            </Box>
          ) : inputMode === 'choice' ? (
            <Box flexDirection="column">
              <Text color="yellow" bold>Please answer the following:</Text>
              {choiceQuestions.map((q, qi) => {
                const focused = choiceFocus === qi
                const selected = choiceSelections[qi] ?? 0
                const effectiveOpts = q.allowOther
                  ? [...q.options, { value: '__other__', label: 'Other (type custom value)' }]
                  : q.options
                return (
                  <Box key={q.id} flexDirection="column" marginTop={1}>
                    <Text color={focused ? 'cyan' : 'white'} bold={focused}>
                      {focused ? '▸ ' : '  '}{qi + 1}. {q.prompt}
                    </Text>
                    <Box marginLeft={4} flexDirection="column">
                      <Box>
                        {effectiveOpts.map((opt, oi) => {
                          const isSel = oi === selected
                          return (
                            <Text key={opt.value} color={isSel ? (focused ? 'cyan' : 'green') : 'gray'} bold={isSel}>
                              {isSel ? '[●] ' : '[ ] '}{opt.label}
                              {oi < effectiveOpts.length - 1 ? '   ' : ''}
                            </Text>
                          )
                        })}
                      </Box>
                      {/* "Other…" 自定义输入框 */}
                      {choiceCustomActive === qi ? (
                        <Box marginTop={1}>
                          <Text color="cyan">  Type: </Text>
                          <Text color="white">{choiceCustomInput}</Text>
                          <Text color="cyan">▎</Text>
                          <Text color="gray" dimColor>  Enter confirm  Esc cancel</Text>
                        </Box>
                      ) : null}
                    </Box>
                  </Box>
                )
              })}
              <Box marginTop={1}>
                {(['Submit', 'Cancel'] as const).map((label, bi) => {
                  const rowIdx = choiceQuestions.length + bi
                  const focused = choiceFocus === rowIdx
                  return (
                    <Text key={label} color={focused ? (label === 'Submit' ? 'green' : 'red') : 'gray'} bold={focused}>
                      {focused ? '▸ ' : '  '}[ {label} ]{bi === 0 ? '   ' : ''}
                    </Text>
                  )
                })}
              </Box>
              <Text color="gray" dimColor>↑↓ row  ←→ option/button  Enter confirm/type  Esc cancel</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {/* 附件指示器 */}
              {(attachments.length > 0 || attachmentErrors.length > 0) ? (
                <Box flexDirection="column" marginBottom={1}>
                  {attachments.map((att, i) => (
                    <Box key={i}>
                      <Text color="cyan">  📎 </Text>
                      <Text color="white">{att.name}</Text>
                      <Text color="gray">  ({att.kind === 'image' ? '🖼️' : att.kind === 'pdf' ? '📄' : '📝'} {att.kind})</Text>
                    </Box>
                  ))}
                  {attachmentErrors.map((err, i) => (
                    <Box key={`err-${i}`}>
                      <Text color="yellow">  ⚠ </Text>
                      <Text color="yellow" dimColor>{err}</Text>
                    </Box>
                  ))}
                </Box>
              ) : null}
              <Box>
                <Text color={inputMode === 'question' ? 'yellow' : isProcessing ? 'gray' : inputValue.startsWith('!') ? 'green' : 'cyan'}>
                  {inputMode === 'question' ? promptText + ' ' : isProcessing ? '  ' : inputValue.startsWith('!') ? <Text bold color="green">$ </Text> : '> '}
                </Text>
                <TextInput
                  value={inputValue}
                  onChange={handleInputChange}
                  onSubmit={handleSubmit}
                  focus={!isProcessing || inputMode === 'question'}
                  placeholder={isProcessing ? 'Esc to cancel…' : ''}
                />
              </Box>
            </Box>
          )}
        </Box>
        {/* 命令补全建议列表 */}
        {renderSuggestions()}
      </Box>

      {/* Transient hint (cleared after a couple seconds, doesn't pollute history) */}
      {transientHint ? (
        <Box paddingX={1}>
          <Text color="yellow" dimColor>{transientHint}</Text>
        </Box>
      ) : null}

      {/* Footer */}
      <Box justifyContent="space-between" paddingX={1}>
        {mcpServers.length > 0 ? (
          <McpStatusPanel serverInfos={mcpServers} />
        ) : null}
        <Box>
          <Text color="gray" dimColor>
          {hasSuggestions
            ? '↑↓ navigate  Tab/→ accept  Esc close  Enter execute'
            : '↑↓ history  @file  /help  Shift+Tab auto  Ctrl+U clear  Esc ' + (isProcessing ? 'cancel' : '/exit quit')}
          </Text>
          <Box>
            {autoMode ? (
              <Text color="green" bold>AUTO  </Text>
            ) : null}
            {usage ? (
              <Text color="gray" dimColor>
                {(() => {
                  const total = usage.inputTokens + usage.cacheReadTokens
                  const pct = Math.min(100, Math.round((total / MAX_CONTEXT) * 100))
                  return `ctx ${pct}% (${fmtTokens(total)}/${fmtTokens(MAX_CONTEXT)})  out ${fmtTokens(usage.outputTokens)}`
                })()}
              </Text>
            ) : null}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
