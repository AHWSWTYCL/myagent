import React from 'react'
import { Box, Text } from 'ink'

/**
 * Claude Code style task execution progress display.
 *
 * Renders a checklist of tasks with:
 *   ◼ (cyan)   → in_progress
 *   ✔ (green)  → completed
 *   ◻ (default)→ pending
 *
 * In-progress tasks show an activity description line below (dim).
 */

export type TaskProgressStatus = 'todo' | 'in_progress' | 'done'

export interface TaskProgressItem {
  title: string
  status: TaskProgressStatus
  /** Present-continuous description shown below in_progress task (e.g. "Running tests…") */
  activity?: string
}

interface Props {
  tasks: TaskProgressItem[]
  /** Agent name shown in the header */
  agentName: string
  /** When true, dim completed tasks and show strikethrough */
  showCompleted?: boolean
}

const STATUS_GLYPH: Record<TaskProgressStatus, string> = {
  done:        '✔',
  in_progress: '◼',
  todo:        '◻',
}

const STATUS_COLOR: Record<TaskProgressStatus, string> = {
  done:        'green',
  in_progress: 'cyan',
  todo:        undefined as any,
}

/**
 * Try to parse structured task progress from free-text liveOutput.
 * Detects common markdown checklist patterns:
 *   - `- [ ] title`    → pending
 *   - `- [x] title`    → completed
 *   - `- [doing] title`→ in_progress
 *
 * Also detects simple numbered task lists:
 *   - `1. ◼ title`     → in_progress
 *   - `1. ✔ title`     → completed
 *   - `1. ◻ title`     → pending
 *
 * Returns null if no structured tasks are found.
 */
export function parseTasksFromOutput(output: string): TaskProgressItem[] | null {
  const lines = output.split('\n')
  const tasks: TaskProgressItem[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    // Markdown: - [ ] / - [x] / - [doing]
    const mdMatch = trimmed.match(/^[-*]\s+\[(\s*|x|doing|done|todo|in_progress)\]\s+(.+)/i)
    if (mdMatch) {
      const status = normalizeStatus(mdMatch[1])
      tasks.push({ title: mdMatch[2].trim(), status })
      continue
    }

    // Numbered: 1. ◼ / ✔ / ◻
    const numMatch = trimmed.match(/^\d+\.\s*([◼✔◻])\s+(.+)/)
    if (numMatch) {
      const status = glyphToStatus(numMatch[1])
      tasks.push({ title: numMatch[2].trim(), status })
      continue
    }

    // Plain task indicator at start of line: ◼ / ✔ / ◻
    const glyphMatch = trimmed.match(/^([◼✔◻])\s+(.+)/)
    if (glyphMatch) {
      const status = glyphToStatus(glyphMatch[1])
      tasks.push({ title: glyphMatch[2].trim(), status })
      continue
    }
  }

  return tasks.length > 0 ? tasks : null
}

function normalizeStatus(raw: string): TaskProgressStatus {
  const s = raw.trim().toLowerCase()
  if (s === 'x' || s === 'done' || s === 'completed') return 'done'
  if (s === 'doing' || s === 'in_progress' || s === 'in-progress') return 'in_progress'
  return 'todo'
}

function glyphToStatus(glyph: string): TaskProgressStatus {
  if (glyph === '✔') return 'done'
  if (glyph === '◼') return 'in_progress'
  return 'todo'
}

/**
 * Try to extract an "activity" description from the raw output lines
 * that follow an in_progress task line. Looks for lines that look like
 * descriptions (not checklist items).
 */
export function extractActivity(output: string, taskTitle: string): string | undefined {
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(taskTitle)) {
      // Look at the next lines for activity descriptions
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const next = lines[j].trim()
        if (!next) continue
        // Skip if it looks like another checklist item
        if (/^[-*\d]/.test(next) || /^[◼✔◻]/.test(next)) break
        // Skip if it looks like a tool call line
        if (/^(Bash|Read|Write|Edit|Glob|Grep|WebSearch)/i.test(next)) break
        return next
      }
      break
    }
  }
  return undefined
}

/**
 * Claude Code style task execution progress component.
 *
 * Usage:
 *   <TaskExecutionProgress tasks={[...]} agentName="researcher" />
 *
 * Output:
 *     ◼ Fixing authentication bug     ← cyan bold (in_progress)
 *       Running tests…                ← dim description
 *     ✔ Fixed database connection     ← green strikethrough (done)
 *     ◻ Add error handling            ← dim (pending)
 */
export function TaskExecutionProgress({ tasks, agentName, showCompleted = true }: Props) {
  if (tasks.length === 0) return null

  // Sort: in_progress first, then todo, then done
  const sorted = [...tasks].sort((a, b) => {
    const order: Record<TaskProgressStatus, number> = { in_progress: 0, todo: 1, done: 2 }
    return order[a.status] - order[b.status]
  })

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {sorted.map((task, i) => {
        const glyph = STATUS_GLYPH[task.status]
        const color = STATUS_COLOR[task.status]
        const isCompleted = task.status === 'done'
        const isInProgress = task.status === 'in_progress'
        const isPending = task.status === 'todo'
        const dim = isCompleted || isPending

        return (
          <Box key={i} flexDirection="column">
            <Box>
              <Text color={color as any} bold={isInProgress}>
                {glyph}{' '}
              </Text>
              <Text
                bold={isInProgress}
                strikethrough={isCompleted}
                dimColor={dim}
                color={dim ? 'gray' : undefined}
              >
                {task.title}
              </Text>
              {isInProgress ? (
                <Text color="gray" dimColor>…</Text>
              ) : null}
            </Box>
            {isInProgress && task.activity ? (
              <Box>
                <Text color="gray">  </Text>
                <Text color="gray" dimColor>{task.activity}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Parse tasks from liveOutput, enrich with activity descriptions, and render.
 * Falls back to showing nothing (caller handles raw output display).
 */
export function useTaskProgressFromOutput(liveOutput: string): {
  tasks: TaskProgressItem[]
  restLines: string[]
} {
  const tasks = parseTasksFromOutput(liveOutput) ?? []
  const enriched = tasks.map(t => ({
    ...t,
    activity: t.activity ?? (t.status === 'in_progress' ? extractActivity(liveOutput, t.title) : undefined),
  }))

  // Filter out lines that were consumed as tasks
  const consumedLines = new Set<number>()
  if (tasks.length > 0) {
    const lines = liveOutput.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      // Mark consumed: task lines
      if (/^[-*]\s+\[/.test(trimmed) || /^\d+\.\s*[◼✔◻]/.test(trimmed) || /^[◼✔◻]\s+/.test(trimmed)) {
        consumedLines.add(i)
      }
    }
  }

  const restLines = liveOutput.split('\n').filter((_, i) => !consumedLines.has(i))

  return { tasks: enriched, restLines }
}
