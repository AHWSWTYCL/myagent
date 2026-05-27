import React from 'react'
import { Box, Text } from 'ink'
import type { DotStatus } from './GlowingDot.js'
import { GlowingDot } from './GlowingDot.js'
import { useToolRender, useToolResult } from './ToolRenderContext.js'

/**
 * One tool call inside a group.
 * Matches the shape used by the pending/completed tool tracking in App.tsx.
 */
export interface GroupedCallItem {
  id: string
  name: string
  input: unknown
  output: string
  isError: boolean
  /** When true, this call is still running. */
  isPending: boolean
}

interface Props {
  /** The common tool name for all calls in this group. */
  name: string
  /** All calls of this type from the same turn. */
  calls: GroupedCallItem[]
  /** Is any call in this group still running? */
  anyPending: boolean
}

/**
 * Formats a tool input into a short one-line summary string.
 * Delegates to the Tool class via useToolRender.
 */
function shortInput(name: string, input: unknown): string {
  const { args } = useToolRender(name, input as Record<string, unknown>)
  return args
}

/** Short one-line output summary (first significant line). */
function shortOutput(name: string, output: string, isError: boolean, input: unknown): string {
  const result = useToolResult(name, output, isError, input as Record<string, unknown>)
  if (result.length === 0) return ''
  return result[0]
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/**
 * Claude Code style grouped tool call view.
 *
 * When multiple tools of the same type run in one turn, they're displayed
 * under a single header with a call count, rather than as separate rows.
 *
 * Pending (running) state:
 *   ⏺ Bash ×2
 *     ├ ls -la
 *     └ git status
 *
 * Completed state (mixed success/error):
 *   ⏺ Bash ×2
 *     ├ ls -la
 *     │ 3 lines
 *     └ git status (error)
 *       fatal: not a git repository
 */
export function GroupedToolCallView({ name, calls, anyPending }: Props) {
  // Hooks must be called unconditionally — call for the first tool as representative
  const { label } = useToolRender(name, calls[0]?.input as Record<string, unknown> ?? {})

  // Overall status: error if any errored, pending if any pending, else success
  const overallStatus: DotStatus = (() => {
    if (anyPending) return 'running'
    if (calls.some(c => c.isError)) return 'error'
    return 'success'
  })()

  return (
    <Box flexDirection="column">
      <Box>
        <GlowingDot status={overallStatus} label={`${label} ×${calls.length}`} />
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {calls.map((call, idx) => {
          const isLast = idx === calls.length - 1
          const prefix = isLast ? '└' : '├'
          // Render per-call header via delegated components
          return <GroupedCallRow key={call.id} call={call} prefix={prefix} />
        })}
      </Box>
    </Box>
  )
}

/** Individual row inside a grouped tool call view. Renders header + output. */
function GroupedCallRow({ call, prefix }: { call: GroupedCallItem; prefix: string }) {
  // Hooks are safe here since this is a separate component with stable render count
  const inputRecord = call.input as Record<string, unknown>
  const { args } = useToolRender(call.name, inputRecord)
  const outputLines = useToolResult(call.name, call.output, call.isError, inputRecord)

  const argText = args || (call.isError ? '(error)' : '(done)')
  const outText = call.isPending ? '' : outputLines.length > 0 ? outputLines[0] : ''

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">{prefix} </Text>
        <Text color={call.isError ? 'red' : undefined} bold={call.isError}>
          {argText}
        </Text>
        {call.isError && !call.isPending ? (
          <Text color="red" dimColor> (error)</Text>
        ) : null}
      </Box>
      {outText ? (
        <Box>
          <Text color="gray">  {outText}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
