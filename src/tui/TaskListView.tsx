import React from 'react'
import { Box, Text } from 'ink'

export interface TaskItem {
  id: string
  title: string
  status: 'todo' | 'in_progress' | 'review' | 'done' | 'blocked' | 'cancelled'
  depends_on?: string[]
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
