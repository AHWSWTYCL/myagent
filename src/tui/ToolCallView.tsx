import React from 'react'
import { Box, Text } from 'ink'
import type { ToolCallPayload } from './types.js'
import { parseTaskListPayload, TaskListView } from './TaskListView.js'
import { GlowingDot, type DotStatus } from './GlowingDot.js'

interface Props {
  payload: ToolCallPayload
  /** When true, render the full tool output (capped at EXPANDED_MAX_LINES) instead of the summary. */
  expanded?: boolean
  /** Whether this card has keyboard focus for interaction. */
  focused?: boolean
  /** Called when user presses Enter on a focused card (re-run bash, etc.). */
  onActivate?: () => void
}

const CWD = process.cwd()
const HOME = process.env.HOME ?? ''

/** Make paths terse: prefer relative-to-cwd, fall back to ~ form. */
function shortPath(p: string): string {
  if (!p) return p
  if (p.startsWith(CWD + '/')) return p.slice(CWD.length + 1)
  if (p === CWD) return '.'
  if (HOME && p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length)
  return p
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
 * When `focused` is true, a green left border highlights the card and
 * pressing Enter triggers onActivate (e.g. re-run a bash command).
 */
export function ToolCallView({ payload, expanded, focused, onActivate }: Props) {
  const { name, input, output, isError } = payload

  // Special case: `task` tool's list action emits a structured payload
  const taskItems = name === 'task' ? parseTaskListPayload(output) : null

  const fmt = formatTool(name, input as Record<string, unknown>, output, !!isError)

  // Decide dot status based on tool result
  const status: DotStatus = isError ? 'error' : 'success'

  // In expanded mode, replace summary with raw output (bounded)
  const lines = expanded ? expandedLines(output) : fmt.summary
  const visible = expanded ? lines : lines.slice(0, SUMMARY_MAX_LINES)
  const totalOutputLines = output.split('\n').length
  const overflow = expanded
    ? Math.max(0, totalOutputLines - EXPANDED_MAX_LINES)
    : Math.max(0, fmt.summary.length - SUMMARY_MAX_LINES)

  // `Done` label: for successful non-bash tools, show "Done" as the label
  // to match Claude Code's "⏺ Done" on completion.
  const showDone = !isError && visible.length === 0 && !taskItems && name !== 'edit_file'

  const headerLabel = showDone ? 'Done' : fmt.label
  const headerSuffix = showDone ? undefined : fmt.args

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

interface Formatted {
  label: string
  args: string
  summary: string[]
}

function formatTool(name: string, input: Record<string, unknown>, output: string, isError: boolean): Formatted {
  const fn = FORMATTERS[name] ?? defaultFormatter
  return fn(input, output, isError)
}

function s(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function summarize(output: string, isError: boolean): string[] {
  const trimmed = output.trimEnd()
  if (!trimmed) return []
  const lines = trimmed.split('\n')
  if (isError) return lines.slice(0, 4).map(l => truncate(l, 200))
  if (lines.length <= 4) return lines.map(l => truncate(l, 200))
  return [
    `${lines.length} lines`,
    truncate(lines[0], 200),
    truncate(lines[1], 200),
    `…`,
    truncate(lines[lines.length - 1], 200),
  ]
}

// ── Per-tool formatters ────────────────────────────────────────────────

const FORMATTERS: Record<string, (input: Record<string, unknown>, output: string, isError: boolean) => Formatted> = {
  bash: (input, output, isError) => ({
    label: 'Bash',
    args: truncate(s(input.command), 120),
    summary: summarize(output, isError),
  }),

  read_file: (input, output, isError) => {
    const p = shortPath(s(input.path))
    if (isError) return { label: 'Read', args: p, summary: summarize(output, true) }
    const lineCount = output.split('\n').length
    return { label: 'Read', args: p, summary: [`Read ${lineCount} line${lineCount === 1 ? '' : 's'}`] }
  },

  write_file: (input, output, isError) => {
    const p = shortPath(s(input.path))
    if (isError) return { label: 'Write', args: p, summary: summarize(output, true) }
    const content = s(input.content)
    const lineCount = content ? content.split('\n').length : 0
    return { label: 'Write', args: p, summary: [`Wrote ${lineCount} line${lineCount === 1 ? '' : 's'}`] }
  },

  edit_file: (input, output, isError) => {
    const p = shortPath(s(input.path))
    if (isError) return { label: 'Edit', args: p, summary: summarize(output, true) }
    return { label: 'Edit', args: p, summary: [] }
  },

  list_dir: (input, output, isError) => {
    const p = shortPath(s(input.path) || '.')
    if (isError) return { label: 'List', args: p, summary: summarize(output, true) }
    const lineCount = output.trim() ? output.trim().split('\n').length : 0
    return { label: 'List', args: p, summary: [`${lineCount} entr${lineCount === 1 ? 'y' : 'ies'}`] }
  },

  glob: (input, output, isError) => {
    const pattern = s(input.pattern)
    if (isError) return { label: 'Glob', args: pattern, summary: summarize(output, true) }
    const lines = output.trim() ? output.trim().split('\n') : []
    return {
      label: 'Glob',
      args: pattern,
      summary: lines.length === 0
        ? ['No matches']
        : [`Found ${lines.length} file${lines.length === 1 ? '' : 's'}`],
    }
  },

  grep: (input, output, isError) => {
    const pat = s(input.pattern)
    if (isError) return { label: 'Grep', args: pat, summary: summarize(output, true) }
    const lines = output.trim() ? output.trim().split('\n') : []
    return {
      label: 'Grep',
      args: pat,
      summary: lines.length === 0
        ? ['No matches']
        : [`Found ${lines.length} match${lines.length === 1 ? '' : 'es'}`],
    }
  },

  web_search: (input, output, isError) => ({
    label: 'WebSearch',
    args: truncate(s(input.query), 80),
    summary: summarize(output, isError),
  }),

  web_fetch: (input, output, isError) => ({
    label: 'WebFetch',
    args: truncate(s(input.url), 80),
    summary: isError ? summarize(output, true) : [`Fetched ${output.length.toLocaleString()} chars`],
  }),

  memory: (input, output, isError) => {
    const action = s(input.action)
    const arg = s(input.path) || s(input.query) || s(input.name)
    return {
      label: 'Memory',
      args: arg ? `${action} ${arg}` : action,
      summary: summarize(output, isError),
    }
  },

  agent: (input, output, isError) => {
    const agent = s(input.agent) || 'sub-agent'
    const task = s(input.task)
    return {
      label: `Task(${agent})`,
      args: truncate(task, 100),
      summary: summarize(output, isError),
    }
  },

  ask_user:        () => ({ label: 'AskUser',       args: '', summary: [] }),
  ask_user_choice: () => ({ label: 'AskUserChoice', args: '', summary: [] }),

  task: (input, output, isError) => {
    const action = s(input.action)
    if (isError) return { label: 'Task', args: action, summary: summarize(output, true) }
    if (action === 'list') {
      const items = parseTaskListPayload(output)
      const n = items?.length ?? 0
      return { label: 'TaskList', args: `${n} task${n === 1 ? '' : 's'}`, summary: [] }
    }
    const id = s(input.id) || s(input.title)
    return { label: 'Task', args: id ? `${action} ${id}` : action, summary: summarize(output, false) }
  },

  use_skill: (input, output, isError) => ({
    label: 'Skill', args: s(input.name), summary: summarize(output, isError),
  }),
  invoke_skill: (input, output, isError) => ({
    label: 'InvokeSkill', args: s(input.name), summary: summarize(output, isError),
  }),
  skill_write: (input, output, isError) => ({
    label: 'SkillWrite', args: s(input.name), summary: summarize(output, isError),
  }),
}

function defaultFormatter(input: Record<string, unknown>, output: string, isError: boolean): Formatted {
  const arg = Object.values(input).find(v => typeof v === 'string' && (v as string).length < 200) as string | undefined
  return {
    label: 'Tool',
    args: arg ? truncate(arg, 100) : '',
    summary: summarize(output, isError),
  }
}

/**
 * Pending tool row — rendered while the tool is still executing.
 * Uses GlowingDot with `running` status (green pulsing/flashing dot).
 * When `liveOutput` is provided (agent tool sub-agent streaming), shows
 * the live text inline under the header, Claude Code style.
 */
export function PendingToolRow({ name, input, liveOutput, isHeartbeating }: {
  name: string
  input: unknown
  liveOutput?: string
  isHeartbeating?: boolean
}) {
  const fmt = formatTool(name, input as Record<string, unknown>, '', false)

  // Show live agent output: last 12 lines
  const liveLines = liveOutput ? liveOutput.trimEnd().split('\n').slice(-12) : []
  const omitted = liveOutput ? (liveOutput.trimEnd().split('\n').length - liveLines.length) : 0

  return (
    <Box flexDirection="column">
      <Box>
        <Text> </Text>
        <GlowingDot
          status="running"
          label={liveOutput ? `Task(${fmt.args})` : fmt.label}
          suffix={liveOutput ? undefined : fmt.args}
        />
        {isHeartbeating && !liveOutput ? (
          <Text color="gray" dimColor>  ✻ cogitating…</Text>
        ) : null}
      </Box>
      {liveLines.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {omitted > 0 ? (
            <Text color="gray" dimColor>… {omitted} earlier line{omitted === 1 ? '' : 's'} omitted</Text>
          ) : null}
          {liveLines.map((line, i) => (
            <Box key={i}>
              <Text color="gray">  {line}</Text>
            </Box>
          ))}
          {isHeartbeating ? (
            <Text color="gray" dimColor>  ✻ cogitating…</Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}
