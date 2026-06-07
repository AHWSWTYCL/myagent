/**
 * teammateRuntime.ts — 独立进程 teammate CLI runtime。
 *
 * 被 agent.ts dispatch 调用（--teammate 模式），不与 TUI/Scheduler 耦合。
 * 核心职责：
 *   1. 解析 CLI 参数
 *   2. 初始化 client + toolRegistrar（最小集，无 TUI 依赖）
 *   3. Mailbox.startWatching(agent_id) ← 跨进程邮件唤醒的关键
 *   4. 构建 AgentRunContext，调用 runAgent(teammateAgent, ...)
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createClient } from '../client.js'
import { loadClaudeSettings } from '../config.js'
import { ToolRegistrar } from '../tools/toolregistrar.js'
import { Mailbox } from '../mailbox/mailbox.js'
import { TranscriptRecorder } from '../utils/transcript.js'
import { teammateAgent } from '../agents/builtin/teammate.js'
import { runAgent } from '../agents/runner.js'
import { validateInput, validateOutput } from '../tools/validator.js'
import type { AgentRunContext } from '../agents/definition.js'
import type { BackgroundAgentResult } from '../tools/agenttool.js'

// ── PID / 状态文件 ────────────────────────────────────────────────────
const RUNTIME_DIR = path.join(os.homedir(), '.myagent', 'runtime', 'teammates')

function ensureRuntimeDir(): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
}

function writePidFile(agentId: string, pid: number, leaderId: string, teamName?: string): void {
  ensureRuntimeDir()
  const file = path.join(RUNTIME_DIR, `${agentId}.json`)
  const spec = {
    agent_id: agentId,
    pid,
    leader_id: leaderId,
    team_name: teamName ?? null,
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    status: 'running' as const,
  }
  fs.writeFileSync(file, JSON.stringify(spec, null, 2), { mode: 0o600 })
}

function updateHeartbeat(agentId: string): void {
  const file = path.join(RUNTIME_DIR, `${agentId}.json`)
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8')
      const spec = JSON.parse(raw)
      spec.heartbeat_at = new Date().toISOString()
      fs.writeFileSync(file, JSON.stringify(spec, null, 2), { mode: 0o600 })
    }
  } catch { /* ignore */ }
}

function removePidFile(agentId: string): void {
  const file = path.join(RUNTIME_DIR, `${agentId}.json`)
  try { fs.unlinkSync(file) } catch { /* ignore */ }
}

// ── Headless executeTool ──────────────────────────────────────────────
async function executeToolHeadless(
  name: string,
  input: unknown,
  toolRegistrar: ToolRegistrar,
): Promise<string> {
  const args = input as Record<string, string>
  try {
    const tool = toolRegistrar.getTool(name)
    if (!tool) return `Error: unknown tool "${name}"`

    const inputCheck = validateInput(tool, input)
    if (!inputCheck.ok) return `Error: ${inputCheck.error}`

    const result = await tool.execute(args, undefined)

    const outputCheck = validateOutput(tool, result)
    if (!outputCheck.ok) {
      process.stderr.write(`[validator] ${outputCheck.error}\n`)
    }

    return result
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ── 最小工具注册（无 TUI 依赖）────────────────────────────────────────
/**
 * 注册 teammate 独立进程所需的工具集。
 * 注意：ChoiceTool / AskTool 依赖 TUI bridge，headless 模式不注册。
 * 其余工具与 bootstrap.ts 保持一致。
 */
async function createToolRegistrar(
  client: ReturnType<typeof createClient>,
  transcriptRecorder: TranscriptRecorder,
): Promise<ToolRegistrar> {
  const registrar = new ToolRegistrar()

  // 文件/目录/代码操作
  registrar.registerTool(new (await import('../tools/readtool.js')).ReadTool())
  registrar.registerTool(new (await import('../tools/writetool.js')).WriteTool())
  registrar.registerTool(new (await import('../tools/listdirtool.js')).ListDirTool())
  registrar.registerTool(new (await import('../tools/bashtool.js')).BashTool())
  registrar.registerTool(new (await import('../tools/globtool.js')).GlobTool())
  registrar.registerTool(new (await import('../tools/greptool.js')).GrepTool())
  registrar.registerTool(new (await import('../tools/edittool.js')).EditTool())

  // 网络工具
  registrar.registerTool(new (await import('../tools/websearchtool.js')).WebSearchTool())
  registrar.registerTool(new (await import('../tools/fetchtool.js')).FetchTool())

  // 记忆系统
  registrar.registerTool(new (await import('../tools/memorytool.js')).MemoryTool())

  // 技能系统
  const { SkillManager } = await import('../skills/skillmanager.js')
  const { CodeReviewSkill } = await import('../skills/codereviewskill.js')
  const { GitSkill } = await import('../skills/gitskill.js')
  const skillManager = new SkillManager()
  skillManager.registerBuiltin(new CodeReviewSkill())
  skillManager.registerBuiltin(new GitSkill())
  await skillManager.loadFromDisk()
  registrar.registerTool(new (await import('../tools/useskilltool.js')).UseSkillTool(skillManager))
  registrar.registerTool(new (await import('../tools/invokeskilltool.js')).InvokeSkillTool(skillManager))

  // 任务系统
  registrar.registerTool(new (await import('../tasks/tasktool.js')).TaskTool())
  registrar.registerTool(new (await import('../tools/todoPlannerTool.js')).TodoPlannerTool())
  registrar.registerTool(new (await import('../tools/todoUpdateTool.js')).TodoUpdateTool())

  // Team / Mailbox
  registrar.registerTool(new (await import('../tools/createteamtool.js')).CreateTeamTool())
  registrar.registerTool(new (await import('../tools/sendmailtool.js')).SendMailTool('main'))
  registrar.registerTool(new (await import('../tools/checkmailtool.js')).CheckMailTool('main'))

  // Sub-agent 系统
  const { AgentRegistry } = await import('../agents/registry.js')
  const { builtinAgents } = await import('../agents/builtin/index.js')
  const { loadAgentsFromDir } = await import('../agents/markdown.js')
  const agentRegistry = new AgentRegistry()
  agentRegistry.registerAll(builtinAgents)
  agentRegistry.registerAll(loadAgentsFromDir(`${process.cwd()}/agents`))

  const agentTool = new (await import('../tools/agenttool.js')).AgentTool(agentRegistry, registrar)
  registrar.registerTool(agentTool)

  // AgentTool 需要 execution context — 给它一个 headless 版本
  agentTool.setExecutionContext({
    client,
    advisorClient: undefined,
    executeTool: (name, input) => executeToolHeadless(name, input, registrar),
    emitLine: line => process.stderr.write(`[sub-agent] ${line}\n`),
    transcriptRecorder,
    onSubAgentDelta: () => {},
    onSubAgentHeartbeat: () => {},
    onSubAgentStart: () => {},
    onSubAgentProgress: () => {},
    onSubAgentDone: () => {},
    onBackgroundAgentResult: (_result: BackgroundAgentResult) => {},
  })

  return registrar
}

// ── CLI 参数解析 ──────────────────────────────────────────────────────

export interface TeammateCliOptions {
  agentId: string
  leaderId: string
  teamName?: string
  role: string
  tools: string
  peers?: string
}

/**
 * 从 process.argv 解析 teammate CLI 参数。
 *
 * 支持两种形式：
 *   myagent teammate --id wk-1 --leader main --team demo --role "..." --tools "..."
 *   myagent --teammate --id wk-1 --leader main --role "..." --tools "..."
 */
export function parseTeammateArgs(argv: string[] = process.argv): TeammateCliOptions | null {
  const isTeammateMode = argv.includes('teammate') || argv.includes('--teammate')
  if (!isTeammateMode) return null

  const getArg = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag)
    if (idx >= 0 && idx + 1 < argv.length) {
      const val = argv[idx + 1]
      if (val.startsWith('-')) return undefined
      return val
    }
    return undefined
  }

  const agentId = getArg('--id') ?? getArg('--agent-id')
  const leaderId = getArg('--leader') ?? getArg('--leader-id') ?? 'main'
  const role = getArg('--role') ?? 'general worker'
  const tools = getArg('--tools') ?? 'read_file,write_file,bash,list_dir,grep,glob'
  const peers = getArg('--peers')
  const teamName = getArg('--team') ?? getArg('--team-name')

  if (!agentId) {
    console.error('Error: --id or --agent-id is required for teammate mode')
    process.exit(1)
  }

  return { agentId, leaderId, teamName, role, tools, peers }
}

// ── Teammate CLI Runtime ──────────────────────────────────────────────

/**
 * 运行独立进程 teammate。
 *
 * 生命周期：
 *   1. 写 PID 文件 + 启动心跳
 *   2. 初始化 client + toolRegistrar
 *   3. Mailbox.startWatching(agentId)  ← 关键：跨进程邮件唤醒
 *   4. 调用 runAgent(teammateAgent, args, ctx) 进入事件循环
 *   5. 收到 close 邮件后优雅退出
 *   6. 清理 PID 文件 + 关闭 mailbox watcher
 */
export async function runTeammateCli(opts: TeammateCliOptions): Promise<void> {
  const { agentId, leaderId, teamName, role, tools, peers } = opts

  // ── 启动横幅 ────────────────────────────────────────────────────
  process.stderr.write(`\n╔══════════════════════════════════════════╗\n`)
  process.stderr.write(`║  myagent teammate (独立进程)             ║\n`)
  process.stderr.write(`╠══════════════════════════════════════════╣\n`)
  process.stderr.write(`║  agent_id:  ${agentId.padEnd(30)}║\n`)
  process.stderr.write(`║  leader_id: ${leaderId.padEnd(30)}║\n`)
  if (teamName) process.stderr.write(`║  team:      ${teamName.padEnd(30)}║\n`)
  process.stderr.write(`║  role:      ${role.slice(0, 30).padEnd(30)}║\n`)
  process.stderr.write(`║  tools:     ${tools.slice(0, 30).padEnd(30)}║\n`)
  process.stderr.write(`║  pid:       ${process.pid.toString().padEnd(30)}║\n`)
  process.stderr.write(`╚══════════════════════════════════════════╝\n\n`)

  // ── PID 文件 + 心跳 ─────────────────────────────────────────────
  writePidFile(agentId, process.pid, leaderId, teamName)
  const heartbeatTimer = setInterval(() => updateHeartbeat(agentId), 5000)

  // ── 信号 / 清理 ─────────────────────────────────────────────────
  let cleanedUp = false

  const cleanup = (reason: string) => {
    if (cleanedUp) return
    cleanedUp = true
    process.stderr.write(`\n[teammate:${agentId}] ${reason}, shutting down...\n`)
    clearInterval(heartbeatTimer)
    removePidFile(agentId)
    Mailbox.stopWatching(agentId)
    try { transcriptRecorder?.closeSession() } catch { /* ignore */ }
    process.exit(0)
  }

  const signal = new AbortController()
  process.on('SIGINT', () => { signal.abort(); cleanup('SIGINT') })
  process.on('SIGTERM', () => { signal.abort(); cleanup('SIGTERM') })
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[teammate:${agentId}] Uncaught: ${err.message}\n`)
    cleanup('uncaughtException')
  })
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[teammate:${agentId}] Unhandled rejection: ${reason}\n`)
  })

  // ── 初始化运行时 ────────────────────────────────────────────────
  let transcriptRecorder: TranscriptRecorder | undefined

  try {
    loadClaudeSettings()
  } catch (err) {
    process.stderr.write(`[teammate:${agentId}] Config error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }

  const client = createClient()
  transcriptRecorder = new TranscriptRecorder()
  transcriptRecorder.initSession(undefined)

  const toolRegistrar = await createToolRegistrar(client, transcriptRecorder)

  // ── 关键：启动 mailbox watcher ─────────────────────────────────
  // 如果不调用 startWatching，Mailbox.waitForMail() 不会被跨进程文件写入唤醒。
  Mailbox.startWatching(agentId)

  // ── 构建 AgentRunContext ───────────────────────────────────────
  const ctx: AgentRunContext = {
    source: leaderId,
    toolRegistrar,
    executeTool: (name, input) => executeToolHeadless(name, input, toolRegistrar),
    emitLine: (line) => process.stderr.write(`[${agentId}] ${line}\n`),
    transcriptRecorder,
    client,
    advisorClient: undefined,
    signal: signal.signal,
    agentId,
    parentAgentId: leaderId,
  }

  // ── 运行 teammate loop ─────────────────────────────────────────
  process.stderr.write(`[teammate:${agentId}] Starting event loop...\n`)

  try {
    const result = await runAgent(teammateAgent, {
      agent_id: agentId,
      leader_id: leaderId,
      team_name: teamName,
      role,
      tools,
      peers,
      task: '', // 无初始任务，从邮箱取
    }, ctx)

    process.stderr.write(`\n[teammate:${agentId}] ${result.slice(0, 300)}\n`)
  } catch (err) {
    process.stderr.write(`[teammate:${agentId}] Error: ${err instanceof Error ? err.message : String(err)}\n`)
  } finally {
    cleanup('done')
  }
}
