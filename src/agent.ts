import { TuiBridge } from './tui/bridge.js'
import { App } from './tui/App.js'
import React from 'react'
import { render } from 'ink'

// Override console.log before any other module code runs (static imports are
// hoisted but their *function bodies* only run when called, so this is safe).
const bridge = new TuiBridge()
console.log = (...args: unknown[]) => {
  bridge.emitMessage('system', args.map(String).join(' '))
}

// ── 全局错误处理器：防止 unhandledRejection / uncaughtException 静默退出 ──
// Node.js v15+ 默认在 unhandledRejection 时以 code 1 退出，但我们希望
// 在 TUI 中显示错误而非让进程悄无声息地消失。
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack}` : String(reason)
  bridge.emitMessage('system', `❌ Unhandled Rejection:\n${msg}`)
  console.error('[myagent] Unhandled Rejection:', reason)
})

process.on('uncaughtException', (err: Error) => {
  const msg = `${err.name}: ${err.message}\n${err.stack?.split('\n').slice(0, 6).join('\n')}`
  bridge.emitMessage('system', `❌ Uncaught Exception:\n${msg}`)
  console.error('[myagent] Uncaught Exception:', err)
  // uncaughtException 后进程状态不可靠，延迟退出让用户看到错误
  setTimeout(() => process.exit(1), 2000)
})

import Anthropic from '@anthropic-ai/sdk'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js'
import { createClient } from './client.js'
import { getSystemPrompt } from './prompt/prompt.js'
import { readCategory } from './memory/memory.js'
import { recallRelevantMemory } from './memory/recall.js'
import { runAgentLoopStream, UsageAccum } from './utils/runagent.js'
import { compactMessages, microcompactMessages, estimateTokens, MICRO_COMPACT_TOKEN_THRESHOLD, COMPACT_TOKEN_THRESHOLD } from './utils/compact.js'
import { ToolRegistrar } from './tools/toolregistrar.js'
import { HookManager } from './hooks/hook.js'
import { LoggerHook } from './hooks/loggerhook.js'
import { PermissionHook } from './hooks/permissionhook.js'
import { AutoPermissionAgent } from './hooks/autopermissionagent.js'
import { extractMemoryFromTurn, appendMemories } from './memory/extract.js'
import { RetrospectiveHook } from './hooks/retrospectivehook.js'
import { SkillManager } from './skills/skillmanager.js'
import { CodeReviewSkill } from './skills/codereviewskill.js'
import { GitSkill } from './skills/gitskill.js'
import { CommandRegistry } from './commands/commandregistry.js'
import { CommandParser } from './commands/commandparser.js'
import { HelpCommand } from './commands/helpcommand.js'
import { SkillCommand } from './commands/skillcommand.js'
import { TaskCommand } from './tasks/taskcommand.js'
import { RetrospectiveCommand } from './commands/retrospectivecommand.js'
import { TokenStatsCommand } from './commands/tokenstatscommand.js'
import { SchedulerTool } from './scheduler/schedulertool.js'
import { SchedulerCommand } from './scheduler/schedulercommand.js'
import { Scheduler } from './scheduler/scheduler.js'
import { MCPManager } from './mcp/mcpmanager.js'
import { handleMCPCommand } from './commands/mcpcommand.js'
import { todoManager } from './todos/todomanager.js'

// ── Init skills ───────────────────────────────────────────────────────────────
const skillManager = new SkillManager()
skillManager.registerBuiltin(new CodeReviewSkill())
skillManager.registerBuiltin(new GitSkill())
await skillManager.loadFromDisk()

// ── Init tools ────────────────────────────────────────────────────────────────
const toolRegistrar = new ToolRegistrar()
toolRegistrar.registerTool(new (await import('./tools/readtool.js')).ReadTool())
toolRegistrar.registerTool(new (await import('./tools/writetool.js')).WriteTool())
toolRegistrar.registerTool(new (await import('./tools/listdirtool.js')).ListDirTool())
toolRegistrar.registerTool(new (await import('./tools/bashtool.js')).BashTool())
toolRegistrar.registerTool(new (await import('./tools/memorytool.js')).MemoryTool())
toolRegistrar.registerTool(new (await import('./tools/useskilltool.js')).UseSkillTool(skillManager))
toolRegistrar.registerTool(new (await import('./tools/invokeskilltool.js')).InvokeSkillTool(skillManager))
toolRegistrar.registerTool(new (await import('./tasks/tasktool.js')).TaskTool())
toolRegistrar.registerTool(new SchedulerTool())
toolRegistrar.registerTool(new (await import('./tools/websearchtool.js')).WebSearchTool())
toolRegistrar.registerTool(new (await import('./tools/fetchtool.js')).FetchTool())
toolRegistrar.registerTool(new (await import('./tools/globtool.js')).GlobTool())
toolRegistrar.registerTool(new (await import('./tools/greptool.js')).GrepTool())
toolRegistrar.registerTool(new (await import('./tools/edittool.js')).EditTool())
toolRegistrar.registerTool(new (await import('./tools/choicetool.js')).ChoiceTool(qs => bridge.askChoice(qs)))
toolRegistrar.registerTool(new (await import('./tools/asktool.js')).AskTool(prompt => bridge.askQuestion(prompt)))
toolRegistrar.registerTool(new (await import('./tools/todoPlannerTool.js')).TodoPlannerTool())
toolRegistrar.registerTool(new (await import('./tools/todoUpdateTool.js')).TodoUpdateTool())

// ── Init agent registry & unified agent tool ─────────────────────────────────
const { AgentRegistry } = await import('./agents/registry.js')
const { builtinAgents } = await import('./agents/builtin/index.js')
const { loadAgentsFromDir } = await import('./agents/markdown.js')
const agentRegistry = new AgentRegistry()
agentRegistry.registerAll(builtinAgents)
// 用户也可以通过 ./agents/*.md 自定义 sub-agent
agentRegistry.registerAll(loadAgentsFromDir(`${process.cwd()}/agents`))

const agentTool = new (await import('./tools/agenttool.js')).AgentTool(agentRegistry, toolRegistrar)
toolRegistrar.registerTool(agentTool)

const client = createClient()

// 当前 runTurn 的 AbortSignal（供 AgentTool 传递给 sub-agent 内部循环）
let currentAbortSignal: AbortSignal | undefined

// AgentTool 需要 client / executeTool / emitLine —— 这些此时才有，在这里注入
agentTool.setExecutionContext({
  client,
  executeTool: (name, input) => executeTool(name, input),
  emitLine: line => bridge.emitMessage('system', line),
  onSubAgentDelta: (name, delta) => bridge.emitSubAgentDelta(name, delta),
  onSubAgentHeartbeat: (name, elapsedMs) => bridge.emitSubAgentHeartbeat(name, elapsedMs),
  onSubAgentStart: (name, description, agentType) => bridge.emitSubAgentStart(name, description, agentType),
  onSubAgentProgress: (name, toolUseCount, tokenCount, lastActivity) => bridge.emitSubAgentProgress(name, toolUseCount, tokenCount, lastActivity),
  onSubAgentDone: (name, status, error) => bridge.emitSubAgentDone(name, status, error),
})

// ── MCP Manager ───────────────────────────────────────────────────────────────
const mcpManager = new MCPManager()
mcpManager.setRegistrar(toolRegistrar)
mcpManager.onStatusChange((infos) => bridge.emitMcpStatus(infos))
await mcpManager.startAll()

// ── Hooks ─────────────────────────────────────────────────────────────────────
const hookManager = new HookManager()
hookManager.register(new LoggerHook(bridge))
const permissionHook = new PermissionHook(prompt => bridge.askPermission(prompt), toolRegistrar)
const autoPermissionAgent = new AutoPermissionAgent(client)
hookManager.register(permissionHook)
hookManager.register(new RetrospectiveHook(client, skillManager, bridge, 30))

bridge.on('autoModeChange', (enabled: boolean) => {
  permissionHook.setAutoMode(enabled, autoPermissionAgent)
})

// ── Todo Manager → Bridge ─────────────────────────────────────────────────
todoManager.on('update', (snapshot) => {
  bridge.emitTodoPlanUpdate(snapshot)
})

// ── ! 命令：执行 bash / !mcp 并推入 messages (Claude Code 模式) ───
// 复用 toolRegistry 中的 BashTool（和 LLM 调用的同个工具），而非另起 execSync。
// 结果以 XML 标签格式推入 messages 供后续 LLM 回合引用，本身不触发 LLM query。
// !mcp 命令被拦截路由到 MCP 命令处理器。
export async function runBash(cmd: string): Promise<string> {
  // !mcp 命令拦截
  if (cmd.trim().toLowerCase().startsWith('mcp')) {
    const args = cmd.trim().slice(3).trim()
    const result = await handleMCPCommand(args, mcpManager)
    messages.push(
      { role: 'user', content: `<mcp-cmd>${args}</mcp-cmd>` },
      { role: 'user', content: `<mcp-result>\n${result}\n</mcp-result>` },
    )
    return result
  }

  const tool = toolRegistrar.getTool('bash')
  if (!tool) return 'Error: Bash tool not found'
  // 跳过权限检查：用户主动输入 ! 命令即已授权
  const result = await tool.execute({ command: cmd })
  messages.push(
    { role: 'user', content: `<bash-input>${cmd}</bash-input>` },
    { role: 'user', content: `<bash-stdout>${result}</bash-stdout>` },
  )
  return result
}

async function executeTool(name: string, input: unknown, skipHooks = false): Promise<string> {
  const args = input as Record<string, string>
  try {
    if (!skipHooks) {
      const pre = await hookManager.runOnToolCall({ toolName: name, toolInput: input })
      if (pre.action === 'block') return `Permission denied: ${pre.reason}`
    }
    const result = await (toolRegistrar.getTool(name)?.execute(args, currentAbortSignal) ?? Promise.resolve('Unknown tool'))
    if (!skipHooks) {
      await hookManager.runOnToolResult({ toolName: name, toolInput: input, toolResult: result })
    }
    return result
  } catch (err) {
    return `Error: ${err}`
  }
}

// ── Agent state ───────────────────────────────────────────────────────────────
const MAX_TURNS = 1000
const messages: Anthropic.MessageParam[] = []
let agentRunning = false
let lastUsage: UsageAccum | null = null

// ── Commands ──────────────────────────────────────────────────────────────────
const commandRegistry = new CommandRegistry()
commandRegistry.register(new HelpCommand(commandRegistry))
commandRegistry.register(new SkillCommand(skillManager, prompt => bridge.askQuestion(prompt)))
commandRegistry.register(new TaskCommand())
// RetrospectiveCommand 需要访问 messages，传一个 getter 函数
commandRegistry.register(new RetrospectiveCommand(client, () => messages, skillManager, bridge))
// TokenStatsCommand 需要访问 lastUsage 和 messages，传 getter 函数
commandRegistry.register(new TokenStatsCommand(() => lastUsage, () => messages))
commandRegistry.register(new SchedulerCommand())
const commandParser = new CommandParser(commandRegistry)

function buildSystemPrompt(memoryFragment: string): string {
  const agentSection = agentRegistry.describeForPrompt() || undefined
  const base = getSystemPrompt(agentSection)
  const withMemory = memoryFragment
    ? `${base}\n\n## 相关记忆\n${memoryFragment}`
    : base
  return `${withMemory}${skillManager.buildPromptFragment()}`
}

async function compactIfNeeded(): Promise<void> {
  const tokenCount = lastUsage ? lastUsage.inputTokens : estimateTokens(messages)

  if (tokenCount >= COMPACT_TOKEN_THRESHOLD) {
    bridge.emitCompacting('start', `${tokenCount.toLocaleString()} tokens`)
    const compacted = await compactMessages(client, 'claude-sonnet-4-6', messages)
    messages.splice(0, messages.length, ...compacted)
    lastUsage = null
    bridge.emitUsageReset()
    bridge.emitCompacting('done', `${tokenCount.toLocaleString()} tokens → ${messages.length} 条消息`)
  } else if (tokenCount >= MICRO_COMPACT_TOKEN_THRESHOLD) {
    const freed = microcompactMessages(messages)
    if (freed > 0) {
      lastUsage = null
      bridge.emitUsageReset()
      bridge.emitCompacting('micro', `释放约 ${freed.toLocaleString()} tokens`)
    }
  }
}

/**
 * Extract plain text from user content for memory recall (strip attachments).
 */
function extractRecallText(content: string | Array<ContentBlockParam | Anthropic.TextBlockParam>): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

export async function runTurn(
  input: string | Array<ContentBlockParam>,
  signal?: AbortSignal,
): Promise<void> {
  // Serialize turns — wait if another turn is already running (e.g. a scheduled task)
  while (agentRunning) {
    await new Promise(r => setTimeout(r, 200))
  }
  agentRunning = true
  currentAbortSignal = signal
  agentTool.setSignal(signal)

  try {
    messages.push({ role: 'user', content: input as Anthropic.MessageParam['content'] })

    // Recall once per user input (not per inner turn)
    const recallText = extractRecallText(input as string | Array<ContentBlockParam>)
    bridge.emitStatus('召回相关记忆...')
    const relevantMemory = await recallRelevantMemory(recallText)
    if (relevantMemory) bridge.emitRecall(relevantMemory)
    bridge.emitStatus(relevantMemory ? '找到相关记忆' : 'thinking...')

    const buildSystem = (): string => buildSystemPrompt(relevantMemory)

    // Accumulate text across inner turns for memory extraction (one pass per user input, not per inner turn)
    let fullAssistantText = ''

    await runAgentLoopStream({
      client,
      model: 'claude-sonnet-4-6',
      system: buildSystem,
      tools: toolRegistrar.getAllTools(),
      messages,
      maxTurns: MAX_TURNS,
      executeTool,
      parallelSafeTools: toolRegistrar.getParallelSafeNames(),
      signal,
      onText: delta => bridge.emitText(delta),
      onTurnEnd: async (text, msgs) => {
        fullAssistantText += text + '\n'
        bridge.emitTurnEnd(text)
        await hookManager.runOnTurnEnd({
          messages: msgs,
          assistantText: text,
          userInput: recallText,
        })
      },
      onToolStart: (callId, name, input) => bridge.emitToolStart(callId, name, input),
      onToolEnd: (callId, name, input, output) => bridge.emitToolEnd(callId, name, input, output),
      onTurnToolReset: () => bridge.emitTurnToolReset(),
      onUsage: stats => {
        lastUsage = stats
        bridge.emitUsage(stats)
      },
    })

    // Extract memories once per user input (not per inner turn)
    if (fullAssistantText.trim()) {
      extractMemoryFromTurn(recallText, fullAssistantText)
        .then(items => {
          if (items.length === 0) return
          const added = appendMemories(items)
          if (added > 0) {
            bridge.emitMessage('system', `[memory] +${added} new memor${added === 1 ? 'y' : 'ies'}`)
          }
        })
        .catch(err => console.error('[extract]', err))
    }

    await compactIfNeeded()
  } finally {
    agentRunning = false
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
const scheduler = new Scheduler(
  prompt => runTurn(prompt),
  () => agentRunning,
  bridge,
)
scheduler.start()

// ── 解析 CLI 参数，决定是 debug 模式还是 TUI ──────────────────────────────
import { parseDebugArgs, DebugCollector, logProgress } from './debug.js'

const debugOpts = parseDebugArgs()

if (debugOpts) {
  // ── Debug 模式：headless 运行，输出 JSON ──────────────────────────────

  // 启用 auto mode — debug 模式无 TUI，不能做交互式授权
  if (!bridge.autoMode) {
    bridge.toggleAutoMode()
    if (debugOpts.autoYes) {
      logProgress.start('Auto mode enabled')
    } else {
      logProgress.start('Auto mode enabled (required by headless debug mode; use --auto-yes to suppress this notice)')
    }
  }

  const collector = new DebugCollector(bridge)
  let aborted = false

  // Ctrl+C 优雅退出
  const onSigint = () => { aborted = true }
  process.on('SIGINT', onSigint)

  logProgress.start(`Starting headless turn: ${debugOpts.input.slice(0, 80)}${debugOpts.input.length > 80 ? '…' : ''}`)
  const signal = new AbortController()

  // 超时自动中断
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  if (debugOpts.timeout) {
    timeoutHandle = setTimeout(() => {
      signal.abort()
      logProgress.ok(`Timeout reached (${debugOpts.timeout}s), aborting...`)
    }, debugOpts.timeout * 1000)
  }

  try {
    await runTurn(debugOpts.input, signal.signal)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    collector.setError(msg)
    logProgress.error(msg)
  }

  // 清理超时定时器
  if (timeoutHandle) clearTimeout(timeoutHandle)

  if (aborted) {
    collector.setError('Interrupted by SIGINT')
    logProgress.error('Interrupted by user')
  }

  // 从 messages 数组构建输出
  const result = collector.buildResult(messages as Array<{ role: string; content: string | Array<unknown> }>)

  const output = JSON.stringify(result, null, 2)

  if (debugOpts.output) {
    // 写文件
    const fs = await import('fs')
    fs.writeFileSync(debugOpts.output, output + '\n')
    logProgress.ok(`Result written to ${debugOpts.output}`)
  } else {
    // 写 stdout
    // 注意：console.log 已被 override 到 bridge.emitMessage，这里必须用
    // process.stdout.write 或原始 console.log 才能让 JSON 到 stdout。
    // 详见 agent.ts 顶部 console.log 的 override 逻辑。
    console.error('─'.repeat(40))
    process.stdout.write(output + '\n')
  }

  // 清理并退出
  scheduler.stop()
  await mcpManager.shutdownAll().catch(() => {})
  process.exit(result.status === 'error' ? 1 : 0)
} else {
  // ── 正常 TUI 模式 ─────────────────────────────────────────────────────
  const toolRenderMap = toolRegistrar.buildToolRenderMap()
  render(React.createElement(App, { bridge, commandParser, runTurn, runBash, toolMap: toolRenderMap }))
}
