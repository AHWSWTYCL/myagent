import React from 'react'
import { Text } from 'ink'
import type { SubAgentTask } from './bridge.js'

/**
 * Eviction grace period (ms) for completed tasks. After this, they disappear
 * from the panel automatically.
 */
const EVICT_AFTER_MS = 5000

/**
 * Build a compact single-line string representation of sub-agent tasks,
 * suitable for rendering inside a Footer row.
 *
 * Example output:
 *   Sub-agents: explore · 3 tools  generator · 2 tools
 *
 * Returns null when there are no tasks.
 */
export function buildSubAgentLine(tasks: SubAgentTask[]): string | null {
  if (tasks.length === 0) return null

  const parts = tasks.map(t => {
    const icon = t.status === 'running' ? '▶' : '▸'
    const toolPart = t.toolUseCount > 0 ? ` · ${t.toolUseCount} tool${t.toolUseCount === 1 ? '' : 's'}` : ''
    return `${icon} ${t.agentType}${toolPart}`
  })

  return `Sub-agents: ${parts.join('  ')}`
}

/**
 * Claude Code style compact sub-agent status element.
 *
 * Renders as a single Text node so it can be embedded into any row:
 *   Sub-agents: explore · 3 tools  generator · 2 tools
 *
 * Returns null (render nothing) when there are no tasks.
 */
export function SubAgentTaskStatus({ tasks }: { tasks: SubAgentTask[] }) {
  const line = buildSubAgentLine(tasks)
  if (!line) return null
  return <Text bold color="gray">{line}</Text>
}

/**
 * Filter tasks that should be visible (not past eviction deadline).
 */
export function getVisibleTasks(tasks: SubAgentTask[]): SubAgentTask[] {
  const now = Date.now()
  return tasks.filter(t => {
    if (t.status === 'running') return true
    if (t.endTime && now - t.endTime > EVICT_AFTER_MS) return false
    return true
  })
}
