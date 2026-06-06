/**
 * BackgroundTasksDialog — teammate 任务状态面板（Ink 弹窗，纯展示组件）。
 *
 * 对标 Claude Code BackgroundTasksDialog：
 *   - 列出所有 running/idle teammate 的状态
 *   - 显示 agentId、角色、状态、工具调用数、邮箱未读数
 *   - 键盘导航由父组件（App.tsx）的 useInput 统一管理
 *
 * 通信仍走 send_mail / check_mail 邮箱系统，此弹窗只做可视化状态面板。
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { TeammateTaskInfo } from '../team/taskRegistry.js'

export interface BackgroundTasksDialogProps {
  tasks: TeammateTaskInfo[]
  /** 当前选中的索引（由父组件管理） */
  selectedIndex: number
  /** 关闭弹窗的回调 */
  onClose: () => void
  /** 终止 teammate 的回调。传入 agentId，调用方发 send_mail(kind=close) */
  onKill: (agentId: string) => void
  /** 查看详情的回调（暂未实现，保留接口） */
  onDetail?: (agentId: string) => void
  /** zoom-in 到 teammate 对话视图的回调 */
  onZoomIn?: (agentId: string) => void
}

const STATUS_LABEL: Record<string, string> = {
  running: 'running',
  idle: 'idle',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
}

const STATUS_COLOR: Record<string, string> = {
  running: 'green',
  idle: 'yellow',
  completed: 'blue',
  failed: 'red',
  killed: 'yellow',
}

export function BackgroundTasksDialog({ tasks, selectedIndex, onClose, onKill, onDetail, onZoomIn }: BackgroundTasksDialogProps) {
  // 安全 clamp：防止 selectedIndex 越界
  const clampedIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, tasks.length - 1))

  if (tasks.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Text color="gray" bold>Background Tasks</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>No teammate tasks.</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Start a teammate with:</Text>
        </Box>
        <Box>
          <Text color="cyan">  agent(agent="teammate", background=true, ...)</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color="cyan" bold>Background Tasks</Text>
        <Text color="gray" dimColor>{'  ↑↓ select · f zoom · x stop · ←/Esc close'}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {tasks.map((task, i) => {
          const selected = i === clampedIndex
          const statusColor = STATUS_COLOR[task.status] ?? 'gray'
          const statusLabel = STATUS_LABEL[task.status] ?? task.status
          const prefix = selected ? ' ❯ ' : '   '

          return (
            <Box key={task.agentId}>
              <Text color={selected ? 'cyan' : 'gray'}>{prefix}</Text>
              <Text color={selected ? 'cyan' : 'white'} bold={selected}>
                @{task.agentId}
              </Text>
              <Text color="gray"> · </Text>
              <Text color={statusColor}>{statusLabel}</Text>
              <Text color="gray"> · </Text>
              <Text dimColor>{task.toolUseCount} tool{task.toolUseCount !== 1 ? 's' : ''}</Text>
              {task.unreadCount > 0 && (
                <>
                  <Text color="gray"> · </Text>
                  <Text color="yellow">{task.unreadCount} unread</Text>
                </>
              )}
              <Text color="gray"> · </Text>
              <Text dimColor>{task.role}</Text>
              {task.teamName && (
                <>
                  <Text color="gray"> · </Text>
                  <Text dimColor>team: {task.teamName}</Text>
                </>
              )}
            </Box>
          )
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {tasks.filter(t => t.status === 'running').length} running,{' '}
          {tasks.filter(t => t.status === 'idle').length} idle,{' '}
          {tasks.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'killed').length} done
        </Text>
      </Box>
    </Box>
  )
}
