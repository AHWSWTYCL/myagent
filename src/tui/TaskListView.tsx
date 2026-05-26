import React from 'react'
import { Box, Text } from 'ink'

export interface TaskItem {
  id: string
  title: string
  status: 'todo' | 'in_progress' | 'review' | 'done' | 'blocked' | 'cancelled'
  depends_on?: string[]
}

const SENTINEL = '__TASK_JSON__:'

/**
 * Try to extract structured task data emitted by the task tool's list action.
 * Returns null if the output doesn't carry a payload.
 */
export function parseTaskListPayload(output: string): TaskItem[] | null {
  const idx = output.indexOf(SENTINEL)
  if (idx < 0) return null
  const json = output.slice(idx + SENTINEL.length).trim()
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed as TaskItem[]
  } catch {
    // not parseable
  }
  return null
}

const STATUS_GLYPH: Record<TaskItem['status'], string> = {
  done:        '✔',
  in_progress: '◼',
  review:      '◐',
  todo:        '◻',
  blocked:     '⏸',
  cancelled:   '✗',
}

const STATUS_COLOR: Record<TaskItem['status'], string> = {
  done:        'green',
  in_progress: 'cyan',
  review:      'yellow',
  todo:        'gray',
  blocked:     'gray',
  cancelled:   'gray',
}

interface Props {
  tasks: TaskItem[]
}

/**
 * Claude Code TodoWrite style checklist:
 *
 *   ⎿  ✔ done item title
 *      ◼ in-progress item title
 *      ◻ todo item title
 *
 * Cancelled / done items are dimmed; in-progress is bold cyan.
 */
export function TaskListView({ tasks }: Props) {
  if (tasks.length === 0) return null
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {tasks.map((t, i) => {
        const glyph = STATUS_GLYPH[t.status]
        const color = STATUS_COLOR[t.status]
        const dim = t.status === 'done' || t.status === 'cancelled'
        const strike = t.status === 'cancelled'
        const bold = t.status === 'in_progress'
        return (
          <Box key={t.id}>
            {i === 0 ? <Text color="gray">⎿  </Text> : <Text color="gray">   </Text>}
            <Text color={color as any} bold={bold}>{glyph} </Text>
            <Text color={dim ? 'gray' : 'white'} dimColor={dim} strikethrough={strike}>
              {t.title}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
