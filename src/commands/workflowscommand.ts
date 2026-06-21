import { Command } from './command.js'
import { workflowRegistry } from '../workflow/registry.js'

function formatDuration(start: number, end?: number): string {
  const ms = (end ?? Date.now()) - start
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

function statusIcon(status: string): string {
  switch (status) {
    case 'running': return '●'
    case 'completed': return '✓'
    case 'failed': return '✗'
    default: return '?'
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'running'
    case 'completed': return 'done'
    case 'failed': return 'FAILED'
    default: return status
  }
}

export class WorkflowsCommand extends Command {
  get name(): string { return 'workflows' }
  get description(): string { return '查看 workflow 运行状态：list / show <runId>' }
  get usage(): string { return '/workflows | /workflows show <runId>' }

  async execute(args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase()

    if (sub === 'show' || sub === 'log') {
      return this.cmdShow(args.slice(1))
    }

    // 默认：list
    return this.cmdList()
  }

  private cmdList(): void {
    const runs = workflowRegistry.list()
    if (runs.length === 0) {
      console.log('暂无 workflow 运行记录。')
      console.log('使用 run_workflow 工具启动一个 workflow。')
      return
    }

    const running = runs.filter(r => r.status === 'running')
    const done = runs.filter(r => r.status !== 'running')

    if (running.length > 0) {
      console.log(`运行中（${running.length} 个）：\n`)
      for (const r of running) {
        const phase = r.currentPhase ? ` [${r.currentPhase}]` : ''
        const agents = r.agents.filter(a => a.status === 'running')
        const agentLine = agents.length > 0
          ? `  ▶ ${agents.map(a => a.label).join(', ')}`
          : ''
        const script = r.scriptPath ? `  script: ${r.scriptPath}` : ''
        console.log(`  ${statusIcon(r.status)} ${r.runId}  ${formatDuration(r.startedAt)}${phase}`)
        if (script) console.log(script)
        if (agentLine) console.log(agentLine)
        console.log(`  /workflows show ${r.runId}  查看执行日志`)
        console.log('')
      }
    }

    if (done.length > 0) {
      console.log(`历史记录（最近 ${Math.min(done.length, 10)} 个）：\n`)
      for (const r of done.slice(0, 10)) {
        const duration = formatDuration(r.startedAt, r.endedAt)
        const agentCount = r.agents.length
        const label = statusColor(r.status)
        const script = r.scriptPath ? `  ${r.scriptPath}` : ''
        console.log(`  ${statusIcon(r.status)} ${r.runId}  ${label}  ${duration}  ${agentCount} agents${script}`)
        if (r.error) console.log(`    错误: ${r.error.slice(0, 80)}`)
      }
    }
  }

  private cmdShow(idArgs: string[]): void {
    if (idArgs.length === 0) {
      // 没有指定 runId：显示最近一条
      const runs = workflowRegistry.list()
      if (runs.length === 0) {
        console.log('暂无 workflow 运行记录。')
        return
      }
      return this.showRun(runs[0].runId)
    }
    return this.showRun(idArgs[0])
  }

  private showRun(runId: string): void {
    const run = workflowRegistry.get(runId)
    if (!run) {
      console.log(`未找到 workflow: ${runId}`)
      console.log('使用 /workflows 查看所有运行记录。')
      return
    }

    console.log(`\nWorkflow: ${run.runId}`)
    console.log(`状态: ${statusIcon(run.status)} ${run.status}`)
    console.log(`耗时: ${formatDuration(run.startedAt, run.endedAt)}`)
    if (run.scriptPath) console.log(`脚本: ${run.scriptPath}`)
    if (run.currentPhase && run.status === 'running') console.log(`当前 phase: ${run.currentPhase}`)
    if (run.error) console.log(`错误: ${run.error}`)

    // agents
    if (run.agents.length > 0) {
      console.log(`\nAgents（${run.agents.length} 个）:`)
      for (const a of run.agents) {
        const icon = a.status === 'running' ? '▶' : a.status === 'cached' ? '◇' : '✓'
        const dur = a.endedAt ? ` ${formatDuration(a.startedAt, a.endedAt)}` : ''
        console.log(`  ${icon} ${a.label}${dur}`)
      }
    }

    // log lines
    if (run.logLines.length > 0) {
      console.log(`\n执行日志（最近 ${run.logLines.length} 行）:`)
      for (const line of run.logLines) {
        console.log(`  ${line}`)
      }
    }
  }
}
