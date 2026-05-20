import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, Static, useInput, useApp, useWindowSize } from 'ink'
import TextInput from 'ink-text-input'
import type { PermissionAnswer } from '../hooks/permissionhook.js'
import type { ChatMessage, PermissionEvent, QuestionEvent, UsageStats } from './types.js'
import type { TuiBridge } from './bridge.js'
import type { CommandParser } from '../commands/commandparser.js'
import type { Suggestion } from '../commands/commandregistry.js'
import { MarkdownRenderer, StreamingText } from './MarkdownRenderer.js'

type InputMode = 'chat' | 'permission' | 'question'

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
  const [promptText, setPromptText] = useState('')
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
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

  useEffect(() => {
    bridge.on('status', (msg: string) => setStatus(msg))

    bridge.on('text', (delta: string) => {
      streamingRef.current += delta
      setStreamingText(streamingRef.current)
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

    bridge.on('permission', ({ prompt, resolve }: PermissionEvent) => {
      setPromptText(prompt + '  (y)es / (a)llow session / (n)o')
      setInputMode('permission')
      pendingResolveRef.current = resolve as (v: any) => void
    })

    bridge.on('question', ({ prompt, resolve }: QuestionEvent) => {
      setPromptText(prompt)
      setInputMode('question')
      pendingResolveRef.current = resolve
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

    setMessages(prev => [...prev, { id: nextId(), role: 'system', content: 'Press Ctrl+C again to exit.' }])
    if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current)
    ctrlCTimerRef.current = setTimeout(() => { ctrlCCountRef.current = 0 }, 2000)
  })

  // Permission mode: y / a / n
  useInput((input) => {
    if (input === 'y' || input === 'Y') {
      pendingResolveRef.current?.('yes' satisfies PermissionAnswer)
      pendingResolveRef.current = null
      setInputMode('chat')
      setPromptText('')
    } else if (input === 'a' || input === 'A') {
      pendingResolveRef.current?.('session' satisfies PermissionAnswer)
      pendingResolveRef.current = null
      setInputMode('chat')
      setPromptText('')
    } else if (input === 'n' || input === 'N') {
      pendingResolveRef.current?.('no' satisfies PermissionAnswer)
      pendingResolveRef.current = null
      setInputMode('chat')
      setPromptText('')
    }
  }, { isActive: inputMode === 'permission' })

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
        setInputValue('')
      } else {
        setHistoryIndex(newIndex)
        setInputValue(inputHistory[newIndex])
      }
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
            <Box key={s.name}>
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
          <Text color="yellow">  ⟳ </Text>
          <Text color="yellow" dimColor>{toolRunning}</Text>
        </Box>
      ) : null}

      {status && !toolRunning ? (
        <Box>
          <Text color="gray" dimColor>  {status}</Text>
        </Box>
      ) : null}

      {/* Input box */}
      <Box borderStyle="single" borderColor={inputMode !== 'chat' ? 'yellow' : isProcessing ? 'gray' : 'cyan'} paddingX={1} flexDirection="column">
        <Box>
          {inputMode === 'permission' ? (
            <Text color="yellow">{promptText}</Text>
          ) : (
            <>
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
            </>
          )}
        </Box>
        {/* 命令补全建议列表 */}
        {renderSuggestions()}
      </Box>

      {/* Footer */}
      <Box justifyContent="space-between" paddingX={1}>
        <Text color="gray" dimColor>
          {hasSuggestions
            ? '↑↓ navigate  Tab/→ accept  Esc close  Enter execute'
            : '↑↓ history  /help  Ctrl+C ' + (isProcessing ? 'cancel' : 'exit×2')}
        </Text>
        {usage ? (
          <Text color="gray" dimColor>
            {`in ${fmtTokens(usage.inputTokens)}  out ${fmtTokens(usage.outputTokens)}`}
            {usage.cacheReadTokens > 0 ? `  cache↑${fmtTokens(usage.cacheReadTokens)}` : ''}
          </Text>
        ) : null}
      </Box>
    </Box>
  )
}
