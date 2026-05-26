import React from 'react'
import { Box, Text } from 'ink'
import type { DotStatus } from './GlowingDot.js'
import { GlowingDot } from './GlowingDot.js'

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
 * Reuses the same logic as ToolCallView/PendingToolRow.
 */
function shortInput(name: string, input: unknown): string {
  const raw = input as Record<string, unknown>
  switch (name) {
    case 'bash':
      return truncate(String(raw.command ?? ''), 120)
    case 'read_file':
      return shortPath(String(raw.path ?? ''))
    case 'write_file':
      return shortPath(String(raw.path ?? ''))
    case 'edit_file':
      return shortPath(String(raw.path ?? ''))
    case 'list_dir':
      return shortPath(String(raw.path ?? '.'))
    case 'glob':
      return truncate(String(raw.pattern ?? ''), 120)
    case 'grep':
      return truncate(String(raw.pattern ?? ''), 120)
    case 'web_search':
      return truncate(String(raw.query ?? ''), 80)
    case 'web_fetch':
      return truncate(String(raw.url ?? ''), 80)
    case 'memory':
      return `${raw.action ?? ''} ${String(raw.path ?? raw.query ?? raw.name ?? '')}`.trim()
    case 'agent':
      return `→ ${String(raw.agent ?? 'sub-agent')}`
    default: {
      const arg = Object.values(raw).find(v => typeof v === 'string' && (v as string).length < 200)
      return arg ? truncate(arg as string, 100) : ''
    }
  }
}

/** Short one-line output summary (first significant line). */
function shortOutput(output: string, isError: boolean): string {
  const trimmed = output.trimEnd()
  if (!trimmed) return ''
  const lines = trimmed.split('\n')
  if (isError) return truncate(lines[0] ?? '', 200)
  // For multi-line output, show line count + first line
  if (lines.length > 4) {
    return `${lines.length} lines · ${truncate(lines[0] ?? '', 100)}`
  }
  return truncate(lines[0] ?? '', 200)
}

function shortPath(p: string): string {
  if (!p) return ''
  const cwd = process.cwd()
  const home = process.env.HOME ?? ''
  if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1)
  if (p === cwd) return '.'
  if (home && p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
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
  // Overall status: error if any errored, pending if any pending, else success
  const overallStatus: DotStatus = (() => {
    if (anyPending) return 'running'
    if (calls.some(c => c.isError)) return 'error'
    return 'success'
  })()

  const label = `${name} ×${calls.length}`

  return (
    <Box flexDirection="column">
      <Box>
        <GlowingDot status={overallStatus} label={label} />
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {calls.map((call, idx) => {
          const isLast = idx === calls.length - 1
          const prefix = isLast ? '└' : '├'
          const argText = shortInput(name, call.input)
          const outText = call.isPending ? '' : shortOutput(call.output, call.isError)
          return (
            <Box key={call.id} flexDirection="column">
              <Box>
                <Text color="gray">{prefix} </Text>
                <Text color={call.isError ? 'red' : undefined} bold={call.isError}>
                  {argText || (call.isError ? '(error)' : '(done)')}
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
        })}
      </Box>
    </Box>
  )
}
