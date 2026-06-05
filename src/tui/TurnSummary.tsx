import React, { useRef, useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { GlowingDot, type DotStatus } from './GlowingDot.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import type { TurnToolItem } from './types.js'

// ── Tool classification ─────────────────────────────────────────────
export const EXPLORATION_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep'])

interface Props {
  turnTools: TurnToolItem[]
  /** When true, show individual items; when false, show one-liner summary. */
  expanded: boolean
  /** Whether any exploration tool is still pending (loading). */
  anyPending: boolean
  /** Whether any completed exploration tool reported an error. */
  anyExplorationError: boolean
}

// ── Helpers ─────────────────────────────────────────────────────────

const CWD = process.cwd()
const HOME = process.env.HOME ?? ''

function shortPath(p: string): string {
  if (!p) return p
  if (p.startsWith(CWD + '/')) return p.slice(CWD.length + 1)
  if (p === CWD) return '.'
  if (HOME && p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length)
  return p
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function getInputPath(name: string, input: unknown): string {
  const raw = input as Record<string, unknown>
  switch (name) {
    case 'read_file': return String(raw.path ?? '')
    case 'list_dir':  return String(raw.path ?? '.')
    case 'glob':      return String(raw.pattern ?? '')
    case 'grep':      return String(raw.pattern ?? '')
  }
  return ''
}

/**
 * Return the short human-readable verb for a tool name.
 */
function toolLabel(name: string): string {
  switch (name) {
    case 'read_file': return 'Read'
    case 'list_dir':  return 'Listed'
    case 'glob':      return 'Searched'
    case 'grep':      return 'Searched'
  }
  return name
}

/**
 * One-line output summary for an exploration tool result.
 */
function outputSummary(output: string, isError: boolean): string {
  const trimmed = output.trimEnd()
  if (!trimmed) return '(empty)'
  const lines = trimmed.split('\n')
  if (isError) return truncate(lines[0] ?? '(error)', 200)
  return `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`
}

// ── useMinDisplayTime ───────────────────────────────────────────────
// Hold each hint for a minimum duration so fast-completing tool calls
// (file reads, search patterns) are readable instead of flickering past in
// a single frame.

const MIN_HINT_DISPLAY_MS = 700

function useMinDisplayTime(value: string | undefined): string | undefined {
  const [displayed, setDisplayed] = useState(value)

  // Track the previous value to detect changes
  const prevRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (value === prevRef.current) return

    // Clear any pending timer
    if (timerRef.current) clearTimeout(timerRef.current)

    if (!value) {
      // No new value — show nothing immediately
      setDisplayed(undefined)
      prevRef.current = value
      return
    }

    // If there's no previously displayed value, show immediately
    if (!displayed) {
      setDisplayed(value)
      prevRef.current = value
      return
    }

    // Value changed: hold old value for min duration, then flip
    timerRef.current = setTimeout(() => {
      setDisplayed(value)
      prevRef.current = value
    }, MIN_HINT_DISPLAY_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [value])

  return displayed
}

// ── Public helpers ──────────────────────────────────────────────────

/** Does this turn have any exploration tools? */
export function hasExplorationTools(tools: TurnToolItem[]): boolean {
  return tools.some(t => EXPLORATION_TOOLS.has(t.name))
}

// ── Component ───────────────────────────────────────────────────────

/**
 * Claude Code style exploration summary.
 *
 * Collapsed (default):
 *   ⏺ Searching for 2 patterns, Reading 3 files…  (Ctrl+O to expand)
 *     ⎿  src/utils/helper.ts
 *
 *   ⏺ Read 3 files, Listed 1 directory  (Ctrl+O to expand)
 *
 * Expanded (Ctrl+O):
 *   ⏺ Read 3 files, Listed 1 directory  (Ctrl+O to collapse)
 *     ✓ Read src/utils/file.ts
 *       ⎿  142 lines
 *     ✓ Read src/utils/path.ts
 *       ⎿  89 lines
 *     ✓ Listed src/components/
 *       ⎿  12 entries
 *
 * Status:
 *   running  ⏺ green pulsing dot + present tense + … + ⎿ hint
 *   success  ⏺ solid green dot  + past tense
 *   error    ⏺ solid red dot    + past tense
 */
export function TurnSummary({
  turnTools,
  expanded,
  anyPending,
  anyExplorationError,
}: Props) {
  // ── Count with max-ref to prevent streaming jitter ──────────────
  const maxReadRef = useRef(0)
  const maxSearchRef = useRef(0)
  const maxListRef = useRef(0)

  let rawReadCount = 0
  let rawSearchCount = 0
  let rawListCount = 0

  for (const t of turnTools.filter(Boolean)) {
    if (!EXPLORATION_TOOLS.has(t.name)) continue
    switch (t.name) {
      case 'read_file': rawReadCount++; break
      case 'list_dir':  rawListCount++;  break
      case 'glob':
      case 'grep':      rawSearchCount++; break
    }
  }

  // Only ever increase — streaming can temporarily decrement counts.
  maxReadRef.current = Math.max(maxReadRef.current, rawReadCount)
  maxSearchRef.current = Math.max(maxSearchRef.current, rawSearchCount)
  maxListRef.current = Math.max(maxListRef.current, rawListCount)

  const readCount = maxReadRef.current
  const searchCount = maxSearchRef.current
  const listCount = maxListRef.current

  if (readCount === 0 && searchCount === 0 && listCount === 0) return null

  // ── Status ──────────────────────────────────────────────────────
  const isActive = anyPending
  const anyError = anyExplorationError
  const status: DotStatus = isActive ? 'running' : anyError ? 'error' : 'success'

  // ── Live hint for current operation ─────────────────────────────
  const explorationTools = turnTools.filter(t => EXPLORATION_TOOLS.has(t.name))
  const pendingTools = explorationTools.filter(t => t.isPending)
  const completedTools = explorationTools.filter(t => !t.isPending)

  const lastPending = pendingTools[pendingTools.length - 1]
  const incomingHint = lastPending
    ? truncate(shortPath(getInputPath(lastPending.name, lastPending.input)), 80)
    : undefined
  const displayedHint = useMinDisplayTime(incomingHint)

  // ── Build summary parts ─────────────────────────────────────────
  const parts: string[] = []

  if (searchCount > 0) {
    const verb = isActive
      ? (parts.length === 0 ? 'Searching for' : 'searching for')
      : (parts.length === 0 ? 'Searched for' : 'searched for')
    parts.push(`${verb} ${searchCount} ${searchCount === 1 ? 'pattern' : 'patterns'}`)
  }

  if (readCount > 0) {
    const verb = isActive
      ? (parts.length === 0 ? 'Reading' : 'reading')
      : (parts.length === 0 ? 'Read' : 'read')
    parts.push(`${verb} ${readCount} ${readCount === 1 ? 'file' : 'files'}`)
  }

  if (listCount > 0) {
    const verb = isActive
      ? (parts.length === 0 ? 'Listing' : 'listing')
      : (parts.length === 0 ? 'Listed' : 'listed')
    parts.push(`${verb} ${listCount} ${listCount === 1 ? 'directory' : 'directories'}`)
  }

  const summaryText = parts.join(', ')

  // ── Expanded mode: list each tool individually ──────────────────
  if (expanded) {
    return (
      <Box flexDirection="column">
        <Box>
          <GlowingDot status={status} label={summaryText} />
          <CtrlOToExpand expanded />
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {completedTools.map((tool, idx) => {
            const path = shortPath(getInputPath(tool.name, tool.input))
            // Show tool entries in reverse chronological order (most recent last)
            // to match the visual flow of a conversation.
            return (
              <Box key={tool.id} flexDirection="column" marginTop={idx > 0 ? 0 : 0}>
                <Box>
                  <Text color={tool.isError ? 'red' : 'green'}>
                    {tool.isError ? '✗' : '✓'}{' '}
                  </Text>
                  <Text bold color={tool.isError ? 'red' : undefined}>
                    {toolLabel(tool.name)}
                  </Text>
                  <Text color="gray"> {truncate(path, 80)}</Text>
                </Box>
                <Box paddingLeft={3}>
                  <Text color="gray" dimColor>
                    {'  ⎿  '}{outputSummary(tool.output, tool.isError)}
                  </Text>
                </Box>
              </Box>
            )
          })}
          {pendingTools.length > 0 && (
            <Box>
              <Text color="gray" dimColor>
                {'  '}{pendingTools.map(t => shortPath(getInputPath(t.name, t.input))).join(', ')}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  }

  // ── Collapsed mode: one-line summary + optional hint ───────────
  return (
    <Box flexDirection="column">
      <Box>
        <GlowingDot
          status={status}
          label={summaryText + (isActive ? '…' : '')}
        />
        {!isActive && <CtrlOToExpand />}
      </Box>
      {isActive && displayedHint && (
        <Box paddingLeft={2}>
          <Text color="gray" dimColor>{'  ⎿  '}{displayedHint}</Text>
        </Box>
      )}
    </Box>
  )
}
