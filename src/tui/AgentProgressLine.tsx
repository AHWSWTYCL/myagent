import React from 'react'
import { Box, Text } from 'ink'

/**
 * Agent progress line — Claude Code style.
 *
 * Each sub-agent renders as:
 *   ├─ explore (researcher) · 5 tool uses
 *   │  ↳ Reading src/foo.ts…
 *   └─ generator · 3 tool uses
 *      ↳ Writing tests…
 *
 * Props are derived from SubAgentTaskState to keep the component pure.
 */

export interface AgentProgressLineProps {
  /** Agent type name shown as a badge, e.g. "explore", "generator" */
  agentType: string
  /** Human-readable description (task description), shown after agent type */
  description?: string
  /** Whether this is the last agent in the list (uses └─ instead of ├─) */
  isLast: boolean
  /** Whether the agent has completed (finished, failed, or killed) */
  isResolved: boolean
  /** Whether agent ended with an error */
  isError: boolean
  /** Whether the agent is running in background (as opposed to foreground) */
  isBackgrounded?: boolean
  /** Number of tool uses so far */
  toolUseCount: number
  /** Current activity description (e.g. "Reading src/foo.ts…") */
  lastActivity?: string
  /** Task description shown as status text when backgrounded */
  taskDescription?: string
}

/** Agent type → display color. Matches Claude Code's badge color convention. */
const AGENT_COLORS: Record<string, string> = {
  explore:    'blue',
  planner:    'magenta',
  generator:  'green',
  verifier:   'yellow',
  bug_intake: 'red',
  analyst:    'cyan',
  'general-purpose': 'cyan',
}

function getColor(agentType: string): string {
  return AGENT_COLORS[agentType] ?? 'cyan'
}

/**
 * Claude Code style agent progress line.
 *
 * Renders a two-line entry for each sub-agent:
 * Line 1: tree_char + [agent_type] (description) · N tool uses
 * Line 2: indented ↳ current activity or "Done"
 */
export function AgentProgressLine({
  agentType,
  description,
  isLast,
  isResolved,
  isError,
  isBackgrounded = false,
  toolUseCount,
  lastActivity,
  taskDescription,
}: AgentProgressLineProps) {
  const treeChar = isLast ? '└─' : '├─'
  const color = getColor(agentType)
  const dimAll = !isResolved

  const statusText = isResolved
    ? isError
      ? 'Failed'
      : isBackgrounded
        ? taskDescription ?? 'Running in background'
        : 'Done'
    : lastActivity ?? 'Initializing…'

  return (
    <Box flexDirection="column">
      {/* Line 1: tree + agent badge + description + stats */}
      <Box paddingLeft={3}>
        <Text dimColor>{treeChar} </Text>
        <Text dimColor={dimAll}>
          <Text backgroundColor={color as any} color="white" bold>{agentType}</Text>
          {description ? <Text> ({description})</Text> : null}
          {' · '}{toolUseCount} tool use{toolUseCount === 1 ? '' : 's'}
        </Text>
      </Box>

      {/* Line 2: activity status */}
      {!isBackgrounded ? (
        <Box paddingLeft={3} flexDirection="row">
          <Text dimColor>{isLast ? '   ↳  ' : '│  ↳  '}</Text>
          <Text dimColor>{statusText}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
