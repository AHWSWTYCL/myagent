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
import { createClient } from './client.js'
import { getSystemPrompt } from './prompt/prompt.js'
import { getMemoryPrompt, readCategory } from './memory/memory.js'
import { recallRelevantMemory } from './memory/recall.js'
import { runAgentLoop, runAgentLoopStream } from './utils/runagent.js'
import { ToolRegistrar } from './tools/toolregistrar.js'
import { HookManager } from './hooks/hook.js'
import { LoggerHook } from './hooks/loggerhook.js'
import { PermissionHook } from './hooks/permissionhook.js'
import { AutoPermissionAgent } from './hooks/autopermissionagent.js'
import { MemoryExtractHook } from './hooks/memoryextracthook.js'
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
toolRegistrar.registerTool(new (await import('./tasks/tasktool.js')).TaskTool())
toolRegistrar.registerTool(new SchedulerTool())
toolRegistrar.registerTool(new (await import('./tools/websearchtool.js')).WebSearchTool())
toolRegistrar.registerTool(new (await import('./tools/fetchtool.js')).FetchTool())
toolRegistrar.registerTool(new (await import('./tools/choicetool.js')).ChoiceTool(qs => bridge.askChoice(qs)))

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
const permissionHook = new PermissionHook(prompt => bridge.askPermission(prompt))
const autoPermissionAgent = new AutoPermissionAgent(client)
hookManager.register(permissionHook)
hookManager.register(new MemoryExtractHook(bridge))
hookManager.register(new RetrospectiveHook(client, skillManager, bridge, 30))

bridge.on('autoModeChange', (enabled: boolean) => {
  permissionHook.setAutoMode(enabled, autoPermissionAgent)
})

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
const MEMORY_CONSOLIDATE_THRESHOLD = 250
const MEMORY_KEEP_RECENT = 100
const messages: Anthropic.MessageParam[] = []
let agentRunning = false

// ── Commands ──────────────────────────────────────────────────────────────────
const commandRegistry = new CommandRegistry()
commandRegistry.register(new HelpCommand(commandRegistry))
commandRegistry.register(new SkillCommand(skillManager, prompt => bridge.askQuestion(prompt)))
commandRegistry.register(new TaskCommand())
// RetrospectiveCommand 需要访问 messages，传一个 getter 函数
commandRegistry.register(new RetrospectiveCommand(client, () => messages, skillManager, bridge))
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

async function consolidateMemory(): Promise<boolean> {
  bridge.emitStatus('整理记忆...')
  const indexBefore = readCategory('index')

  const historyText = messages
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

  await runAgentLoop({
    client,
    model: 'claude-sonnet-4-6',
    system: getMemoryPrompt(),
    tools: toolRegistrar.getAllTools(),
    messages: [{ role: 'user', content: `以下是最近的对话记录，请整理：\n\n${historyText}` }],
    maxTurns: MAX_TURNS,
    executeTool: (name, input) => executeTool(name, input, true),
  })

  const indexAfter = readCategory('index')
  return indexAfter !== indexBefore
}

export async function runTurn(input: string, signal?: AbortSignal): Promise<void> {
  // Serialize turns — wait if another turn is already running (e.g. a scheduled task)
  while (agentRunning) {
    await new Promise(r => setTimeout(r, 200))
  }
  agentRunning = true

  try {
    messages.push({ role: 'user', content: input })

    // Recall + system prompt are now re-evaluated at every inner turn
    // (matching Claude Code's queryLoop), via the function form of `system`.
    let lastRecall: string | null = null
    const buildSystem = async (): Promise<string> => {
      bridge.emitStatus('召回相关记忆...')
      const relevantMemory = await recallRelevantMemory(input)
      if (relevantMemory && relevantMemory !== lastRecall) {
        bridge.emitRecall(relevantMemory)
        lastRecall = relevantMemory
      }
      bridge.emitStatus(relevantMemory ? '找到相关记忆' : 'thinking...')
      return buildSystemPrompt(relevantMemory)
    }

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
        bridge.emitTurnEnd(text)
        await hookManager.runOnTurnEnd({
          messages: msgs,
          assistantText: text,
          userInput: input,
        })
      },
      onToolStart: (name, input) => bridge.emitToolStart(name, toolLabel(name, input as Record<string, unknown>)),
      onUsage: stats => bridge.emitUsage(stats),
    })

    if (messages.length >= MEMORY_CONSOLIDATE_THRESHOLD) {
      const ok = await consolidateMemory()
      if (ok) trimMessagesKeepingRecent(messages, MEMORY_KEEP_RECENT)
    }
  } finally {
    agentRunning = false
  }
}

function isToolResultMessage(m: Anthropic.MessageParam): boolean {
  if (m.role !== 'user' || typeof m.content === 'string') return false
  return m.content.some(b => b.type === 'tool_result')
}

function trimMessagesKeepingRecent(messages: Anthropic.MessageParam[], keepRecent: number): void {
  if (messages.length <= keepRecent) return
  let cut = messages.length - keepRecent
  // Walk forward to a clean boundary: a user message whose content is NOT tool_result.
  // This avoids orphaning a tool_use (in an earlier assistant msg) from its tool_result.
  while (cut < messages.length) {
    const m = messages[cut]
    if (m.role === 'user' && !isToolResultMessage(m)) break
    cut++
  }
  if (cut >= messages.length) return
  messages.splice(0, cut)
}

function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'bash':        return `$ ${args.command}`
    case 'read_file':   return `read ${args.path}`
    case 'write_file':  return `write ${args.path}`
    case 'list_dir':    return `ls ${args.path}`
    case 'web_search':  return `search "${args.query}"`
    case 'web_fetch':   return `fetch ${args.url}`
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
render(React.createElement(App, { bridge, commandParser, runTurn }))
