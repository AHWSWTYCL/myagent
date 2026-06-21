// WorkflowRegistry — 跟踪所有 workflow 运行状态（内存，进程生命周期内有效）

export type WorkflowStatus = 'running' | 'completed' | 'failed'

export interface WorkflowAgentEntry {
  label: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'cached'
}

export interface WorkflowRun {
  runId: string
  scriptPath?: string       // 持久化的脚本文件路径
  status: WorkflowStatus
  currentPhase: string
  logLines: string[]        // phase/log/agent 进度行（最近 200 条）
  agents: WorkflowAgentEntry[]
  startedAt: number
  endedAt?: number
  error?: string
}

const MAX_LOG_LINES = 200

class WorkflowRegistry {
  private runs = new Map<string, WorkflowRun>()

  start(runId: string, scriptPath?: string): void {
    this.runs.set(runId, {
      runId,
      scriptPath,
      status: 'running',
      currentPhase: '',
      logLines: [],
      agents: [],
      startedAt: Date.now(),
    })
  }

  setPhase(runId: string, phase: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.currentPhase = phase
    this.appendLog(runId, `── phase: ${phase}`)
  }

  appendLog(runId: string, line: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.logLines.push(line)
    if (run.logLines.length > MAX_LOG_LINES) {
      run.logLines = run.logLines.slice(-MAX_LOG_LINES)
    }
  }

  agentStart(runId: string, label: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.agents.push({ label, startedAt: Date.now(), status: 'running' })
    this.appendLog(runId, `  ▶ agent: ${label}`)
  }

  agentDone(runId: string, label: string, cached = false): void {
    const run = this.runs.get(runId)
    if (!run) return
    const idx = run.agents.map((a, i) => ({ a, i })).reverse().find(({ a }) => a.label === label && a.status === 'running')
    const entry = idx ? run.agents[idx.i] : undefined
    if (entry) {
      entry.endedAt = Date.now()
      entry.status = cached ? 'cached' : 'done'
    }
    this.appendLog(runId, `  ${cached ? '◇' : '✓'} agent: ${label}${cached ? ' (cached)' : ''}`)
  }

  complete(runId: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.status = 'completed'
    run.endedAt = Date.now()
  }

  fail(runId: string, error: string): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.status = 'failed'
    run.endedAt = Date.now()
    run.error = error
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId)
  }

  list(): WorkflowRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  listRunning(): WorkflowRun[] {
    return this.list().filter(r => r.status === 'running')
  }
}

export const workflowRegistry = new WorkflowRegistry()
