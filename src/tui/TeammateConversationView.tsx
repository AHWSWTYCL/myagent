/**
 * TeammateConversationView — zoom-in teammate 对话视图。
 *
 * 设计（Advisor 推荐方案）：
 *   - incoming messages：从 mailbox 读取（peek，不消费）
 *   - outgoing messages：本地 state（optimistic）
 *   - 发送：走 Mailbox.send（直接写文件，不绕主 agent）
 *   - 刷新：每 1s 轮询 mailbox
 *   - 键盘：自身 useInput 管理，不回传给父组件
 *   - 回退：Esc → 返回 BackgroundTasksDialog
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Box, Text, useInput } from 'ink'
import { Mailbox, formatMail, type Mail } from '../mailbox/mailbox.js'
import type { TeammateTaskInfo } from '../team/taskRegistry.js'

const POLL_INTERVAL_MS = 1000

export interface TeammateConversationViewProps {
  /** teammate 的 agent_id */
  teammateId: string
  /** teammate 的元数据 */
  task: TeammateTaskInfo | undefined
  /** 主 agent 的 id（发件人） */
  userId: string
  /** 返回 task list */
  onBack: () => void
}

interface DisplayMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  from: string
  body: string
  timestamp: number
  status?: 'sending' | 'sent' | 'failed'
}

export function TeammateConversationView({ teammateId, task, userId, onBack }: TeammateConversationViewProps) {
  const [input, setInput] = useState('')
  const [outgoingMessages, setOutgoingMessages] = useState<DisplayMessage[]>([])
  const [incomingMessages, setIncomingMessages] = useState<DisplayMessage[]>([])
  const [error, setError] = useState('')
  const outgoingCounter = useRef(0)
  // ref 保存最新 input，避免 useInput 闭包过期拿到 stale state
  const inputRef = useRef('')

  // ── 读取 mailbox 中的 incoming 消息 ──────────────────────────────
  const refreshIncoming = useCallback(() => {
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
  }, [teammateId])

  // 初始加载 + 轮询
  useEffect(() => {
    refreshIncoming()
    const timer = setInterval(refreshIncoming, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refreshIncoming])

  // 同步 ref ↔ state，确保 useInput 拿到最新 input
  useEffect(() => {
    inputRef.current = input
  }, [input])

  // ── 合并消息列表（按时间排序）──────────────────────────────────
  const allMessages = [...incomingMessages, ...outgoingMessages]
    .sort((a, b) => a.timestamp - b.timestamp)

  // ── 发送消息 ──────────────────────────────────────────────────
  const sendMessage = useCallback(() => {
    const text = inputRef.current.trim()
    if (!text) return

    const now = Date.now()
    const tempId = `out-${++outgoingCounter.current}`

    // optimistic：先添加到本地列表
    const optimistic: DisplayMessage = {
      id: tempId,
      direction: 'outgoing',
      from: userId,
      body: text,
      timestamp: now,
      status: 'sending',
    }
    setOutgoingMessages(prev => [...prev, optimistic])
    setInput('')
    setError('')

    // 通过 Mailbox.send 直接写文件，不绕主 agent
    try {
      Mailbox.send({
        from: userId,
        to: teammateId,
        subject: 'User message',
        kind: 'task',
        body: text,
        meta: { source: 'teammateView' },
      })
      setOutgoingMessages(prev => prev.map(m =>
        m.id === tempId ? { ...m, status: 'sent' as const } : m
      ))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Send failed: ${msg}`)
      setOutgoingMessages(prev => prev.map(m =>
        m.id === tempId ? { ...m, status: 'failed' as const } : m
      ))
    }
  }, [userId, teammateId])

  // ── 键盘处理：组件自身接管，不再由父组件 useInput 代理 ──
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
    // 普通文本输入（排除组合键）
    if (_input && !key.ctrl && !key.meta) {
      setInput(prev => prev + _input)
    }
  })

  // 状态标签
  const statusColor = task?.status === 'running' ? 'green' : 'yellow'
  const statusLabel = task?.status ?? 'unknown'

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
    >
      {/* 标题行 */}
      <Box>
        <Text color="cyan" bold>@{teammateId}</Text>
        <Text color="gray"> · </Text>
        <Text color={statusColor}>{statusLabel}</Text>
        {task && (
          <>
            <Text color="gray"> · </Text>
            <Text dimColor>{task.toolUseCount} tool{task.toolUseCount !== 1 ? 's' : ''}</Text>
            <Text color="gray"> · </Text>
            <Text dimColor>{task.role}</Text>
          </>
        )}
        <Text color="gray" dimColor>{'  Esc back'}</Text>
      </Box>

      {/* 消息列表 */}
      <Box marginTop={1} flexDirection="column">
        {allMessages.length === 0 ? (
          <Box>
            <Text dimColor>No messages yet. Type below and press Enter to send.</Text>
          </Box>
        ) : (
          allMessages.map(m => {
            const isOutgoing = m.direction === 'outgoing'
            const prefix = isOutgoing ? '  ▶ you: ' : '  ◀ @' + m.from + ': '
            const statusMark = m.status === 'sending' ? ' …' : m.status === 'failed' ? ' ✗' : ''
            return (
              <Box key={m.id} flexDirection="column">
                <Box>
                  <Text color={isOutgoing ? 'green' : 'cyan'}>{prefix}</Text>
                  <Text color={m.status === 'failed' ? 'red' : undefined}>
                    {m.body.length > 200 ? m.body.slice(0, 197) + '…' : m.body}
                  </Text>
                  <Text color="red" dimColor>{statusMark}</Text>
                </Box>
              </Box>
            )
          })
        )}
      </Box>

      {/* 错误提示 */}
      {error ? (
        <Box marginTop={0}>
          <Text color="red">⚠ {error}</Text>
        </Box>
      ) : null}

      {/* 输入区域 */}
      <Box marginTop={1}>
        <Text color="cyan">{'> '}</Text>
        <Text>{input}</Text>
        <Text color="cyan">▌</Text>
        <Text color="gray" dimColor>{'  Enter send · Esc back'}</Text>
      </Box>
    </Box>
  )
}
