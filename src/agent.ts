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
const baseSystemPrompt = getSystemPrompt()

// AgentTool 需要 client / executeTool / emitLine —— 这些此时才有，在这里注入
agentTool.setExecutionContext({
  client,
  executeTool: (name, input) => executeTool(name, input),
  emitLine: line => bridge.emitMessage('system', line),
})

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

// ── ! 命令：执行 bash 并推入 messages (Claude Code 模式) ───────────
// 复用 toolRegistry 中的 BashTool（和 LLM 调用的同个工具），而非另起 execSync。
// 结果以 XML 标签格式推入 messages 供后续 LLM 回合引用，本身不触发 LLM query。
export async function runBash(cmd: string): Promise<string> {
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
    const result = await (toolRegistrar.getTool(name)?.execute(args) ?? Promise.resolve('Unknown tool'))
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
  const base = memoryFragment
    ? `${baseSystemPrompt}\n\n## 相关记忆\n${memoryFragment}`
    : baseSystemPrompt
  const agentSection = agentRegistry.describeForPrompt()
  const withAgents = agentSection ? `${base}\n\n${agentSection}` : base
  return `${withAgents}${skillManager.buildPromptFragment()}`
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
      onToolStart: (name, input) => bridge.emitToolStart(name, toolLabel(name, input as Record<string, unknown>)),
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

function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'bash':        return `$ ${args.command}`
    case 'read_file':   return `read ${args.path}`
    case 'write_file':  return `write ${args.path}`
    case 'list_dir':    return `ls ${args.path}`
    case 'web_search':  return `search "${args.query}"`
    case 'web_fetch':   return `fetch ${args.url}`
    case 'glob':        return `glob ${args.pattern}`
    case 'grep':        return `grep ${args.pattern}`
    case 'edit_file':   return `edit ${args.path}`
    default:           return name
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
const scheduler = new Scheduler(
  prompt => runTurn(prompt),
  () => agentRunning,
  bridge,
)
scheduler.start()

// ── Render TUI ────────────────────────────────────────────────────────────────
render(React.createElement(App, { bridge, commandParser, runTurn, runBash }))
