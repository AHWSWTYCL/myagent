/**
 * TeammateConversationView — zoom-in teammate 对话视图。
 *
 * 数据源优先级：
 *   1. transcript（task.transcriptPath 存在时）— 从 NDJSON 重建完整执行轨迹
 *   2. mailbox（fallback）— 只读未读邮件
 *
 * 模式：
 *   - running/idle teammate：可发送新消息
 *   - completed/failed/killed teammate：readOnly，仅展示历史
 *
 * 键盘：自身 useInput 管理，不回传给父组件。Esc → 返回。
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { Mailbox, type Mail } from '../mailbox/mailbox.js'
import type { TeammateTaskInfo } from '../team/taskRegistry.js'
import {
  loadTranscriptEvents,
  transcriptToDisplayMessages,
  type DisplayMessage,
} from '../utils/transcriptReader.js'

const POLL_INTERVAL_MS = 1000

export interface TeammateConversationViewProps {
  teammateId: string
  task: TeammateTaskInfo | undefined
  userId: string
  onBack: () => void
}

export function TeammateConversationView({ teammateId, task, userId, onBack }: TeammateConversationViewProps) {
  const [input, setInput] = useState('')
  const [outgoingMessages, setOutgoingMessages] = useState<DisplayMessage[]>([])
  const [incomingMessages, setIncomingMessages] = useState<DisplayMessage[]>([])
  const [transcriptMessages, setTranscriptMessages] = useState<DisplayMessage[]>([])
  const [error, setError] = useState('')
  const outgoingCounter = useRef(0)
  const inputRef = useRef('')

  const isTerminal = task?.status === 'completed' || task?.status === 'failed' || task?.status === 'killed'
  const hasTranscript = !!task?.transcriptPath

  // ── Transcript 加载 + 轮询 ──────────────────────────────────────────
  const refreshTranscript = useCallback(() => {
    if (!task?.transcriptPath) return
    try {
      const events = loadTranscriptEvents(task.transcriptPath)
      setTranscriptMessages(transcriptToDisplayMessages(events, teammateId))
    } catch {
      // transcript 可能还在写入中，忽略 transient 错误
    }
  }, [task?.transcriptPath, teammateId])

  useEffect(() => {
    refreshTranscript()
    const timer = setInterval(refreshTranscript, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refreshTranscript])

  // ── Mailbox（fallback：只在没有 transcript 时使用）──────────────────
  const refreshIncoming = useCallback(() => {
    if (hasTranscript) return
    try {
      const msgs = Mailbox.list('main', { from: teammateId })
      const display: DisplayMessage[] = msgs.map((m: Mail) => ({
        id: m.id,
        direction: 'incoming' as const,
        from: m.from,
        body: m.body,
        timestamp: new Date(m.created_at).getTime(),
      }))
      setIncomingMessages(display)
    } catch {
      // mailbox 可能还不存在，忽略
    }
  }, [teammateId, hasTranscript])

  useEffect(() => {
    refreshIncoming()
    const timer = setInterval(refreshIncoming, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refreshIncoming])

  useEffect(() => {
    inputRef.current = input
  }, [input])

  // ── 合并消息列表 ──────────────────────────────────────────────────
  const allMessages = hasTranscript
    ? [...transcriptMessages, ...outgoingMessages]
        .sort((a, b) => a.timestamp - b.timestamp)
    : [...incomingMessages, ...outgoingMessages]
        .sort((a, b) => a.timestamp - b.timestamp)

  // ── 发送消息 ──────────────────────────────────────────────────────
  const sendMessage = useCallback(() => {
    if (isTerminal) return

    const text = inputRef.current.trim()
    if (!text) return

    const now = Date.now()
    const tempId = `out-${++outgoingCounter.current}`

    const optimistic: DisplayMessage = {
      id: tempId,
      direction: 'outgoing',
      from: userId,
      body: text,
      timestamp: now,
    }
    setOutgoingMessages(prev => [...prev, optimistic])
    setInput('')
    setError('')

    try {
      Mailbox.send({
        from: userId,
        to: teammateId,
        subject: 'User message',
        kind: 'task',
        body: text,
        meta: { source: 'teammateView' },
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Send failed: ${msg}`)
    }
  }, [userId, teammateId, isTerminal])

  // ── 键盘处理 ─────────────────────────────────────────────────────
  useInput((_input, key) => {
    if (key.escape) {
      setInput('')
      setError('')
      onBack()
      return
    }
    if (key.return) {
      sendMessage()
      return
    }
    if (key.backspace || (key.ctrl && _input === 'h')) {
      setInput(prev => prev.slice(0, -1))
      return
    }
    if (_input && !key.ctrl && !key.meta) {
      setInput(prev => prev + _input)
    }
  })

  // 状态标签
  const statusColor =
    task?.status === 'running' ? 'green'
    : task?.status === 'completed' ? 'blue'
    : task?.status === 'failed' ? 'red'
    : task?.status === 'killed' ? 'yellow'
    : 'gray'
  const statusLabel = task?.status ?? 'unknown'

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      {/* 标题行 */}
      <Box>
        <Text color="cyan" bold>@{teammateId}</Text>
        <Text color="gray"> · </Text>
        <Text color={statusColor}>{statusLabel}</Text>
        {isTerminal && <Text color="gray" dimColor> (read-only)</Text>}
        {task && (
          <>
            <Text color="gray"> · </Text>
            <Text dimColor>{task.toolUseCount} tool{task.toolUseCount !== 1 ? 's' : ''}</Text>
            <Text color="gray"> · </Text>
            <Text dimColor>{task.role}</Text>
          </>
        )}
        {hasTranscript && <Text color="gray" dimColor> · transcript</Text>}
        <Text color="gray" dimColor>{'  Esc back'}</Text>
      </Box>

      {/* 消息列表 */}
      <Box marginTop={1} flexDirection="column">
        {allMessages.length === 0 ? (
          <Box>
            <Text dimColor>
              {hasTranscript
                ? 'Loading transcript…'
                : isTerminal
                  ? 'No conversation history available.'
                  : 'No messages yet. Type below and press Enter to send.'}
            </Text>
          </Box>
        ) : (
          allMessages.map(m => {
            const isOutgoing = m.direction === 'outgoing'
            const prefix = isOutgoing ? '  \u25B6 you: ' : '  \u25C0 @' + m.from + ': '
            return (
              <Box key={m.id} flexDirection="column">
                <Box>
                  <Text color={isOutgoing ? 'green' : 'cyan'}>{prefix}</Text>
                  <Text>
                    {m.body.length > 200 ? m.body.slice(0, 197) + '\u2026' : m.body}
                  </Text>
                </Box>
              </Box>
            )
          })
        )}
      </Box>

      {/* 错误提示 */}
      {error ? (
        <Box marginTop={0}>
          <Text color="red">{'\u26A0'} {error}</Text>
        </Box>
      ) : null}

      {/* 输入区域 */}
      <Box marginTop={1}>
        {isTerminal ? (
          <Text color="gray" dimColor>
            This teammate has {task?.status}. Start a new task to continue.
          </Text>
        ) : (
          <>
            <Text color="cyan">{'> '}</Text>
            <Text>{input}</Text>
            <Text color="cyan">{'\u258C'}</Text>
            <Text color="gray" dimColor>{'  Enter send \u00B7 Esc back'}</Text>
          </>
        )}
      </Box>
    </Box>
  )
}
