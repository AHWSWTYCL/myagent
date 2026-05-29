import React, { useEffect, useRef } from 'react'
import { Box, Text } from 'ink'
import type { TodoPlanSnapshot } from '../todos/todo.js'
import { TODO_STATUS_ICON, PROGRESS_BAR_WIDTH } from '../todos/todo.js'

interface TodoPanelProps {
  plan: TodoPlanSnapshot | null
}

/**
 * TodoPanel — 固定在 InputBox 上方的待办清单面板。
 *
 * 行为：
 * - 无 plan 时渲染空（返回 null）。
 * - plan 有任务但未全部完成/失败时：渲染面板，固定不滚动。
 * - 全部完成或任意失败：面板保留 5 秒后自动隐藏。
 * - 进度条使用 ██ 字符，Claude Code 风格。
 */
export function TodoPanel({ plan }: TodoPanelProps) {
  // 当 plan isComplete 时，5 秒后自动隐藏
  const [pendingDismiss, setPendingDismiss] = React.useState(false)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (plan?.isComplete) {
      // 启动 5 秒倒计时
      if (!dismissTimerRef.current) {
        dismissTimerRef.current = setTimeout(() => {
          setPendingDismiss(true)
          dismissTimerRef.current = null
        }, 5000)
      }
    } else {
      // 未完成时取消倒计时并保证显示
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }
      setPendingDismiss(false)
    }

    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }
    }
  }, [plan?.isComplete, plan?.progress])

  // 无 plan 或 已标记隐藏 → 不渲染
  if (!plan) return null
  if (pendingDismiss) return null

  const total = plan.tasks.length
  const doneCount = plan.tasks.filter(t => t.status === 'done').length
  const pct = total > 0 ? doneCount / total : 0
  const filled = Math.round(pct * PROGRESS_BAR_WIDTH)

  return (
    <Box flexDirection="column" marginY={1} paddingX={1}>
      {/* 标题行 */}
      <Box>
        <Text bold>{plan.description}</Text>
        <Text color="gray" dimColor>  {plan.progress}</Text>
      </Box>

      {/* 进度条 */}
      <Box marginY={0}>
        <Text>{'  ─ '}</Text>
        <Text color="cyan">
          {'█'.repeat(filled)}{'░'.repeat(PROGRESS_BAR_WIDTH - filled)}
        </Text>
        <Text color="gray" dimColor>{` ${doneCount}/${total}`}</Text>
      </Box>

      {/* 任务列表 */}
      {plan.tasks.map((task, i) => {
        const icon = TODO_STATUS_ICON[task.status]
        const isActive = task.status === 'in_progress'
        const isFailed = task.status === 'failed'
        const isDone = task.status === 'done'

        return (
          <Box key={i} marginLeft={2}>
            <Text
              color={
                isFailed ? 'red' :
                isDone ? 'green' :
                isActive ? 'cyan' :
                'gray'
              }
              dimColor={task.status === 'pending'}
              bold={isActive}
            >
              {icon} {task.description}
            </Text>
            {task.error ? (
              <Text color="red" dimColor> — {task.error}</Text>
            ) : null}
          </Box>
        )
      })}

      {/* 完成/失败提示 */}
      {plan.allDone ? (
        <Box marginTop={0}>
          <Text color="green">✅ All tasks completed.</Text>
        </Box>
      ) : plan.hasFailure ? (
        <Box marginTop={0}>
          <Text color="red">⚠ Some tasks failed. Review and decide next steps.</Text>
        </Box>
      ) : null}
    </Box>
  )
}
