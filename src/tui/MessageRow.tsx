import React from 'react'
import { Box, Text } from 'ink'
import type { ChatMessage } from './types.js'
import type { DiffLine } from '../tools/edittool.js'
import { MarkdownRenderer } from './MarkdownRenderer.js'
import { DiffView } from './DiffView.js'
import { ToolCallView } from './ToolCallView.js'
import { TurnSummary } from './TurnSummary.js'

interface DiffMeta {
  id: string
  filePath: string
  lines: DiffLine[]
  additions: number
  removals: number
}

interface Props {
  msg: ChatMessage
  diffs: DiffMeta[]
  /** Global "expand all tool outputs" toggle, driven by Ctrl+O. */
  expanded?: boolean
}

/**
 * Claude Code style message row.
 *   user:   "> {text}"     (plain, dimmed prompt)
 *   agent:  "⏺ {markdown}"  (cyan dot, full markdown body)
 *   tool:   "  ⎿ {text}"   (indented, gray, no dot)
 *   system: "  · {text}"   (indented, dim)
 */
export function MessageRow({ msg, diffs, expanded }: Props) {
  if (msg.role === 'user') {
    return (
      <Box>
        <Text color="gray">{'> '}</Text>
        <Text>{msg.content}</Text>
      </Box>
    )
  }

  if (msg.role === 'tool') {
    // Structured tool-call entry (Claude Code style): "⏺ Tool(args)" + "  ⎿ result".
    if (msg.toolCall) {
      return <ToolCallView payload={msg.toolCall} expanded={expanded} />
    }
    // Edit_file entries are tracked by id in editDiffs.
    const diff = diffs.find(d => d && d.id === msg.id)
    if (diff) {
      return (
        <DiffView
          filePath={diff.filePath}
          lines={diff.lines}
          additions={diff.additions}
          removals={diff.removals}
        />
      )
    }
    return (
      <Box>
        <Text color="gray">  ⎿  </Text>
        <Text color="gray" wrap="wrap">{msg.content}</Text>
      </Box>
    )
  }

  if (msg.role === 'system') {
    // Per-round exploration summary: render as TurnSummary (GlowingDot + Ctrl+O to expand).
    if (msg.explorationSummary) {
      const s = msg.explorationSummary
      return (
        <Box marginBottom={0}>
          <TurnSummary
            turnTools={s.tools}
            expanded={expanded ?? false}
            anyPending={false}
            anyExplorationError={s.anyError}
          />
        </Box>
      )
    }
    return (
      <Box>
        <Text color="gray" dimColor>  · </Text>
        <Text color="gray" dimColor wrap="wrap">{msg.content}</Text>
      </Box>
    )
  }

  // agent
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">⏺ </Text>
        <Box flexDirection="column" flexGrow={1}>
          <MarkdownRenderer content={msg.content} />
        </Box>
      </Box>
    </Box>
  )
}
