import React from 'react'
import { Box, Text } from 'ink'
import type { ToolCallPayload } from './types.js'
import { TaskListView, type TaskItem } from './TaskListView.js'
import { GlowingDot, type DotStatus } from './GlowingDot.js'
import { TaskExecutionProgress, useTaskProgressFromOutput } from './TaskExecutionProgress.js'
import { useToolRender, useToolResult, useToolInstance } from './ToolRenderContext.js'
import type { TaskTool } from '../tasks/tasktool.js'

interface Props {
  payload: ToolCallPayload
  /** When true, render the full tool output (capped at EXPANDED_MAX_LINES) instead of the summary. */
  expanded?: boolean
  /** Whether this card has keyboard focus for interaction. */
  focused?: boolean
  /** Called when user presses Enter on a focused card (re-run bash, etc.). */
  onActivate?: () => void
}

/**
 * Claude Code style tool-call card. Two parts:
 *   - Header: "⏺ ToolName(arg)" — colored dot + bold label
 *   - Result: "  ⎿  one-line snippet" in gray
 *
 * Status colors:
 *   running → green dot pulsing bright↔dim (flashing glow)
 *   success → solid green dot
 *   error   → solid red dot
 *
 * 渲染委托给 Tool 类的 renderToolUseMessage / renderToolResult 方法。
 */
export function ToolCallView({ payload, expanded, focused, onActivate }: Props) {
  const { name, input, output, isError } = payload
  const inputRecord = input as Record<string, unknown>

  // 通过 Tool 基类委托渲染
  const { label, args } = useToolRender(name, inputRecord)
  const summary = useToolResult(name, output, !!isError, inputRecord)

  // Special case: `task` tool's list action — read structured data from tool instance
  // side-channel instead of parsing a sentinel from output (avoids polluting LLM context).
  const taskToolInstance = useToolInstance('task') as TaskTool | undefined
  const taskItems: TaskItem[] | null = name === 'task' ? (taskToolInstance?.lastListPayload ?? null) : null

  // Decide dot status based on tool result
  const status: DotStatus = isError ? 'error' : 'success'

  // In expanded mode, replace summary with raw output (bounded)
  const lines = expanded ? expandedLines(output) : summary
  const visible = expanded ? lines : lines.slice(0, SUMMARY_MAX_LINES)
  const totalOutputLines = output.split('\n').length
  const overflow = expanded
    ? Math.max(0, totalOutputLines - EXPANDED_MAX_LINES)
    : Math.max(0, summary.length - SUMMARY_MAX_LINES)

  // `Done` label: for successful tools with no summary output
  const showDone = !isError && visible.length === 0 && !taskItems && name !== 'edit_file'

  const headerLabel = showDone ? 'Done' : label
  const headerSuffix = showDone ? undefined : args

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        {/* Focus indicator: green vertical bar when this card is selected */}
        {focused ? <Text color="green">▎</Text> : <Text> </Text>}
        <GlowingDot
          status={status}
          label={headerLabel}
          suffix={headerSuffix}
        />
        {focused ? (
          <Text color="green" dimColor>  ⏎</Text>
        ) : null}
      </Box>
      {taskItems ? (
        <TaskListView tasks={taskItems} />
      ) : visible.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {visible.map((line, i) => (
            <Box key={i}>
              {i === 0 ? <Text color="gray">⎿  </Text> : <Text color="gray">   </Text>}
              <Text color={isError ? 'red' : 'gray'} dimColor={!isError}>{line}</Text>
            </Box>
          ))}
          {overflow > 0 ? (
            <Box>
              <Text color="gray">   </Text>
              <Text color="gray" dimColor>… +{overflow} more line{overflow === 1 ? '' : 's'}{!expanded ? ' (Enter to expand)' : ''}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

const SUMMARY_MAX_LINES = 6
const EXPANDED_MAX_LINES = 80

function expandedLines(output: string): string[] {
  const trimmed = output.trimEnd()
  if (!trimmed) return []
  return trimmed.split('\n').slice(0, EXPANDED_MAX_LINES).map(l => truncate(l, 400))
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/**
 * Pending tool row — rendered while the tool is still executing.
 * Uses GlowingDot with `running` status (green pulsing/flashing dot).
 *
 * When `liveOutput` is provided (agent tool sub-agent streaming), shows:
 *   1. Structured task checklist (if parseable from liveOutput)
 *   2. Raw output lines below
 *
 * 渲染委托给 Tool 类的 renderToolUseMessage 方法。
 */
export function PendingToolRow({ name, input, liveOutput, isHeartbeating }: {
  name: string
  input: unknown
  liveOutput?: string
  isHeartbeating?: boolean
}) {
  const inputRecord = input as Record<string, unknown>
  const { label, args } = useToolRender(name, inputRecord)
  const isAgent = name === 'agent'

  // Try to parse structured tasks from liveOutput (for agent sub-agents)
  const { tasks: parsedTasks, restLines } = liveOutput && isAgent
    ? useTaskProgressFromOutput(liveOutput)
    : { tasks: [], restLines: liveOutput?.split('\n') ?? [] }

  // Show live agent output: last 12 lines (excluding consumed task lines)
  const liveLines = restLines.slice(-12)
  const totalLines = restLines.length
  const omitted = totalLines - liveLines.length

  // Extract agent name from input
  const agentName = isAgent
    ? inputRecord?.agent as string ?? args
    : undefined

  // Determine the header suffix: heartbeat indicator
  const headerSuffix = isAgent && liveOutput
    ? (agentName ?? args)
    : args

  return (
    <Box flexDirection="column">
      <Box>
        <Text> </Text>
        <GlowingDot
          status="running"
          label={isAgent && agentName ? `Task(${agentName})` : label}
          suffix={isAgent && liveOutput ? undefined : headerSuffix}
        />
        {isHeartbeating ? (
          <Text color="gray" dimColor>…</Text>
        ) : null}
      </Box>

      {/* Structured task checklist (from liveOutput parsing) */}
      {parsedTasks.length > 0 ? (
        <TaskExecutionProgress tasks={parsedTasks} agentName={agentName ?? 'agent'} />
      ) : null}

      {/* Raw live output lines (what wasn't consumed as tasks) */}
      {liveLines.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {omitted > 0 ? (
            <Text color="gray" dimColor>… {omitted} earlier line{omitted === 1 ? '' : 's'} omitted</Text>
          ) : null}
          {liveLines.map((line, i) => (
            <Box key={i}>
              {i === 0 && !parsedTasks.length ? (
                <Text color="gray">⎿  </Text>
              ) : (
                <Text color="gray">   </Text>
              )}
              <Text color="gray">{line}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
