import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, Static, useInput, useApp, useWindowSize } from 'ink'
import TextInput from 'ink-text-input'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { ChatMessage, ChoiceEvent, ChoiceQuestion, ChoiceResult, PermissionEvent, QuestionEvent, UsageStats } from './types.js'
import type { TuiBridge } from './bridge.js'
import type { CommandParser } from '../commands/commandparser.js'
import type { Suggestion } from '../commands/commandregistry.js'
import { MarkdownRenderer, StreamingText } from './MarkdownRenderer.js'

type InputMode = 'chat' | 'permission' | 'question' | 'choice'

interface Props {
  bridge: TuiBridge
  commandParser: CommandParser
  runTurn: (input: string, signal?: AbortSignal) => Promise<void>
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

export function App({ bridge, commandParser, runTurn }: Props) {
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
  const [promptText, setPromptText] = useState('')
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [autoMode, setAutoMode] = useState(false)
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
  const ctrlCCountRef = useRef(0)
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const nextId = () => String(++idCounter.current)

  historyIndexRef.current = historyIndex

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
    })

    bridge.on('usage', (stats: UsageStats) => {
      setUsage(stats)
      setToolRunning('')
    })

    bridge.on('recall', (memory: string) => {
      setMessages(prev => [...prev, { id: nextId(), role: 'system', content: `[recalled memory]\n${memory}` }])
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
      setInputMode('choice')
      pendingResolveRef.current = resolve as (v: any) => void
    })

    return () => { bridge.removeAllListeners() }
  }, [bridge])

  // Ctrl+C: first press cancels current request, second press exits
  useInput((_input, key) => {
    if (!key.ctrl || _input !== 'c') return

    if (isProcessing) {
      abortControllerRef.current?.abort()
      ctrlCCountRef.current = 0
      return
    }

    ctrlCCountRef.current += 1
    if (ctrlCCountRef.current >= 2) {
      exit()
      return
    }

    showHint('Press Ctrl+C again to exit.')
    if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current)
    ctrlCTimerRef.current = setTimeout(() => { ctrlCCountRef.current = 0 }, 2000)
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

    const finish = (result: ChoiceResult) => {
      pendingResolveRef.current?.(result)
      pendingResolveRef.current = null
      setInputMode('chat')
      setChoiceQuestions([])
      setChoiceSelections([])
      setChoiceFocus(0)
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
      const optCount = choiceQuestions[choiceFocus].options.length
      if (key.leftArrow) {
        setChoiceSelections(prev => {
          const next = [...prev]
          next[choiceFocus] = (next[choiceFocus] - 1 + optCount) % optCount
          return next
        })
        return
      }
      if (key.rightArrow) {
        setChoiceSelections(prev => {
          const next = [...prev]
          next[choiceFocus] = (next[choiceFocus] + 1) % optCount
          return next
        })
        return
      }
      // 在问题行按 Enter 等同于跳到 Submit 行
      if (key.return) {
        setChoiceFocus(submitRow)
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
          choiceQuestions.forEach((q, i) => {
            answers[q.id] = q.options[choiceSelections[i]].value
          })
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

  // ── 输入变化 ──────────────────────────────────────────────────────

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value)
    updateSuggestions(value)
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

    setInputValue('')
    setHistoryIndex(-1)
    clearSuggestions()
    if (isProcessing) return

    if (commandParser.isCommand(trimmed)) {
      await commandParser.dispatch(trimmed)
      return
    }

    addToHistory(trimmed)
    setMessages(prev => [...prev, { id: nextId(), role: 'user', content: trimmed }])
    setIsProcessing(true)
    setStatus('thinking...')
    streamingRef.current = ''
    setStreamingText('')

    const ac = new AbortController()
    abortControllerRef.current = ac

    try {
      await runTurn(trimmed, ac.signal)
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
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  function fmtTokens(n: number): string {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
  }

  // ── 消息渲染 ────────────────────────────────────────────────────────

  function renderMessage(msg: ChatMessage) {
    if (msg.role === 'tool' || msg.role === 'system') {
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

  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(msg) => renderMessage(msg)}
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

      {status && !toolRunning ? (
        <Box>
          <Text color="gray" dimColor>  {SPINNER_FRAMES[spinnerFrame]} {status}</Text>
          {elapsedSec > 0 ? <Text color="gray" dimColor>{`  ${elapsedSec}s`}</Text> : null}
        </Box>
      ) : null}

      {/* Input box */}
      <Box borderStyle="single" borderColor={inputMode !== 'chat' ? 'yellow' : isProcessing ? 'gray' : 'cyan'} paddingX={1} flexDirection="column">
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
                return (
                  <Box key={q.id} flexDirection="column" marginTop={1}>
                    <Text color={focused ? 'cyan' : 'white'} bold={focused}>
                      {focused ? '▸ ' : '  '}{qi + 1}. {q.prompt}
                    </Text>
                    <Box marginLeft={4}>
                      {q.options.map((opt, oi) => {
                        const isSel = oi === selected
                        return (
                          <Text key={opt.value} color={isSel ? (focused ? 'cyan' : 'green') : 'gray'} bold={isSel}>
                            {isSel ? '[●] ' : '[ ] '}{opt.label}
                            {oi < q.options.length - 1 ? '   ' : ''}
                          </Text>
                        )
                      })}
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
              <Text color="gray" dimColor>↑↓ row  ←→ option/button  Enter confirm  Esc cancel</Text>
            </Box>
          ) : (
            <Box>
              <Text color={inputMode === 'question' ? 'yellow' : isProcessing ? 'gray' : 'cyan'}>
                {inputMode === 'question' ? promptText + ' ' : isProcessing ? '  ' : '> '}
              </Text>
              <TextInput
                value={inputValue}
                onChange={handleInputChange}
                onSubmit={handleSubmit}
                focus={!isProcessing || inputMode === 'question'}
                placeholder={isProcessing ? 'Ctrl+C to cancel…' : ''}
              />
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
        <Text color="gray" dimColor>
          {hasSuggestions
            ? '↑↓ navigate  Tab/→ accept  Esc close  Enter execute'
            : '↑↓ history  /help  Shift+Tab auto  Ctrl+U clear  Ctrl+C ' + (isProcessing ? 'cancel' : 'exit×2')}
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
  )
}
