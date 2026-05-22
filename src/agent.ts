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
import { SkillManager } from './skills/skillmanager.js'
import { CodeReviewSkill } from './skills/codereviewskill.js'
import { GitSkill } from './skills/gitskill.js'
import { CommandRegistry } from './commands/commandregistry.js'
import { CommandParser } from './commands/commandparser.js'
import { HelpCommand } from './commands/helpcommand.js'
import { SkillCommand } from './commands/skillcommand.js'
import { TaskCommand } from './tasks/taskcommand.js'
import { RetrospectiveCommand } from './commands/retrospectivecommand.js'
import { runRetrospective } from './retrospective/retrospective.js'
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
toolRegistrar.registerTool(new (await import('./tools/agenttool.js')).AgentTool())
toolRegistrar.registerTool(new (await import('./tools/builtin/planneragenttool.js')).PlannerAgentTool())
toolRegistrar.registerTool(new (await import('./tools/builtin/generatortool.js')).GeneratorTool())
toolRegistrar.registerTool(new (await import('./tools/builtin/verifiertool.js')).VerifierTool())
toolRegistrar.registerTool(new (await import('./tools/memorytool.js')).MemoryTool())
toolRegistrar.registerTool(new (await import('./tools/useskilltool.js')).UseSkillTool(skillManager))
toolRegistrar.registerTool(new (await import('./tasks/tasktool.js')).TaskTool())
toolRegistrar.registerTool(new SchedulerTool())
toolRegistrar.registerTool(new (await import('./tools/websearchtool.js')).WebSearchTool())
toolRegistrar.registerTool(new (await import('./tools/fetchtool.js')).FetchTool())

const client = createClient()
const baseSystemPrompt = getSystemPrompt()

// ── Hooks ─────────────────────────────────────────────────────────────────────
const hookManager = new HookManager()
hookManager.register(new LoggerHook(bridge))
const permissionHook = new PermissionHook(prompt => bridge.askPermission(prompt))
const autoPermissionAgent = new AutoPermissionAgent(client)
hookManager.register(permissionHook)

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
const MAX_TURNS = 20
const MEMORY_CONSOLIDATE_THRESHOLD = 100
const RETROSPECTIVE_THRESHOLD = 30
let turnsSinceLastRetrospective = 0
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
  return `${base}${skillManager.buildPromptFragment()}`
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

    bridge.emitStatus('召回相关记忆...')
    const relevantMemory = await recallRelevantMemory(input)
    bridge.emitStatus(relevantMemory ? '找到相关记忆' : 'thinking...')

    const systemPrompt = buildSystemPrompt(relevantMemory)

    await runAgentLoopStream({
      client,
      model: 'claude-sonnet-4-6',
      system: systemPrompt,
      tools: toolRegistrar.getAllTools(),
      messages,
      maxTurns: MAX_TURNS,
      executeTool,
      parallelSafeTools: toolRegistrar.getParallelSafeNames(),
      signal,
      onText: delta => bridge.emitText(delta),
      onTurnEnd: text => bridge.emitTurnEnd(text),
      onToolStart: (name, input) => bridge.emitToolStart(name, toolLabel(name, input as Record<string, unknown>)),
      onUsage: stats => bridge.emitUsage(stats),
    })

    if (messages.length >= MEMORY_CONSOLIDATE_THRESHOLD) {
      const ok = await consolidateMemory()
      if (ok) messages.length = 0
    }

    turnsSinceLastRetrospective++
    if (turnsSinceLastRetrospective >= RETROSPECTIVE_THRESHOLD) {
      turnsSinceLastRetrospective = 0
      runRetrospective(client, [...messages], skillManager, msg => bridge.emitStatus(msg))
        .catch(err => console.error('[retrospective]', err))
    }
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
