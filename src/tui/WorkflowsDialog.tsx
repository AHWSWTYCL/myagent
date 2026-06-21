/**
 * WorkflowsDialog — workflow 运行状态面板（Ink 弹窗）。
 *
 * 仿照 BackgroundTasksDialog 风格：
 *   - 列表视图：所有 workflow 运行记录
 *   - 详情视图：选中 workflow 的 phase、agents、日志
 *
 * 键盘由父组件（App.tsx）的 useInput 统一管理。
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { WorkflowRun } from '../workflow/registry.js'

export type WorkflowsDialogView = 'list' | 'detail'

export interface WorkflowsDialogProps {
  runs: WorkflowRun[]
  selectedIndex: number
  view: WorkflowsDialogView
  onClose: () => void
}

function formatDuration(start: number, end?: number): string {
  const s = Math.floor(((end ?? Date.now()) - start) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

const STATUS_COLOR: Record<string, string> = {
  running: 'green',
  completed: 'blue',
  failed: 'red',
}

const STATUS_ICON: Record<string, string> = {
  running: '●',
  completed: '✓',
  failed: '✗',
}

function AgentIcon({ status }: { status: string }) {
  if (status === 'running') return <Text color="green">▶ </Text>
  if (status === 'cached') return <Text color="gray">◇ </Text>
  return <Text color="blue">✓ </Text>
}

function ListView({ runs, selectedIndex }: { runs: WorkflowRun[]; selectedIndex: number }) {
  const clamped = Math.min(Math.max(0, selectedIndex), Math.max(0, runs.length - 1))

  if (runs.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>No workflows have run yet.</Text>
        <Text dimColor>Use the run_workflow tool to start one.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {runs.map((run, i) => {
        const selected = i === clamped
        const color = STATUS_COLOR[run.status] ?? 'gray'
        const icon = STATUS_ICON[run.status] ?? '?'
        const prefix = selected ? ' ❯ ' : '   '
        const phase = run.currentPhase ? ` [${run.currentPhase}]` : ''
        const agentsDone = run.agents.filter(a => a.status !== 'running').length
        const agentsRunning = run.agents.filter(a => a.status === 'running').length
        const agentStr = agentsRunning > 0
          ? `${agentsRunning} running`
          : `${agentsDone} agents`
        const scriptName = run.scriptPath
          ? run.scriptPath.split('/').pop()!
          : 'inline'

        return (
          <Box key={run.runId} flexDirection="column">
            <Box>
              <Text color={selected ? 'cyan' : 'gray'}>{prefix}</Text>
              <Text color={selected ? 'cyan' : 'white'} bold={selected}>{run.runId}</Text>
              <Text color="gray">  </Text>
              <Text color={color}>{icon} {run.status}</Text>
              <Text color="gray">  </Text>
              <Text dimColor>{formatDuration(run.startedAt, run.endedAt)}</Text>
              <Text color="gray">  </Text>
              <Text dimColor>{agentStr}</Text>
              {phase ? <Text color="yellow">{phase}</Text> : null}
            </Box>
            {selected && (
              <Box paddingLeft={5}>
                <Text dimColor>{scriptName}</Text>
                {run.error ? <Text color="red">  {run.error.slice(0, 60)}</Text> : null}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function DetailView({ run }: { run: WorkflowRun }) {
  const color = STATUS_COLOR[run.status] ?? 'gray'
  const icon = STATUS_ICON[run.status] ?? '?'
  const logLines = run.logLines.slice(-20)

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header */}
      <Box>
        <Text bold color="white">{run.runId}</Text>
        <Text color="gray">  </Text>
        <Text color={color}>{icon} {run.status}</Text>
        <Text color="gray">  </Text>
        <Text dimColor>{formatDuration(run.startedAt, run.endedAt)}</Text>
        {run.currentPhase ? <Text color="yellow">  phase: {run.currentPhase}</Text> : null}
      </Box>
      {run.scriptPath && (
        <Box>
          <Text dimColor>script: {run.scriptPath}</Text>
        </Box>
      )}
      {run.error && (
        <Box marginTop={1}>
          <Text color="red">error: {run.error.slice(0, 80)}</Text>
        </Box>
      )}

      {/* Agents */}
      {run.agents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>agents ({run.agents.length})</Text>
          {run.agents.slice(-12).map((a, i) => (
            <Box key={i} paddingLeft={2}>
              <AgentIcon status={a.status} />
              <Text color={a.status === 'running' ? 'green' : a.status === 'cached' ? 'gray' : 'white'}>
                {a.label}
              </Text>
              {a.endedAt
                ? <Text dimColor>  {formatDuration(a.startedAt, a.endedAt)}</Text>
                : a.status === 'running'
                  ? <Text color="green">  {formatDuration(a.startedAt)}…</Text>
                  : null}
            </Box>
          ))}
        </Box>
      )}

      {/* Log */}
      {logLines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>log (last {logLines.length})</Text>
          {logLines.map((line, i) => (
            <Box key={i} paddingLeft={2}>
              <Text dimColor>{line}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

export function WorkflowsDialog({ runs, selectedIndex, view, onClose }: WorkflowsDialogProps) {
  const clamped = Math.min(Math.max(0, selectedIndex), Math.max(0, runs.length - 1))
  const selectedRun = runs[clamped]

  const hint = view === 'list'
    ? '↑↓ select · Enter detail · Ctrl+W/Esc close'
    : '← back · Ctrl+W/Esc close'

  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      flexDirection="column"
    >
      {/* Title bar */}
      <Box>
        <Text color="magenta" bold>Workflows</Text>
        {runs.length > 0 && (
          <>
            <Text color="gray">  </Text>
            <Text dimColor>
              {runs.filter(r => r.status === 'running').length} running,{' '}
              {runs.filter(r => r.status === 'completed').length} done,{' '}
              {runs.filter(r => r.status === 'failed').length} failed
            </Text>
          </>
        )}
        <Text color="gray" dimColor>{'  ' + hint}</Text>
      </Box>

      {/* Body */}
      {view === 'list'
        ? <ListView runs={runs} selectedIndex={clamped} />
        : selectedRun
          ? <DetailView run={selectedRun} />
          : <Text dimColor>No workflow selected.</Text>}
    </Box>
  )
}
