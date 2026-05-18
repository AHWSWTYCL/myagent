import Anthropic from '@anthropic-ai/sdk'
import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import { createClient } from './client'

import { getSystemPrompt } from './prompt/prompt'
import { getMemoryPrompt, readCategory } from './memory/memory'
import { recallRelevantMemory } from './memory/recall'
import { runAgentLoop, runAgentLoopStream } from './utils/runagent'

import { ToolRegistrar } from './tools/toolregistrar'
import { HookManager } from './hooks/hook.js'
import { LoggerHook } from './hooks/loggerhook.js'
import { PermissionHook } from './hooks/permissionhook.js'
import { SkillManager } from './skills/skillmanager.js'
import { CodeReviewSkill } from './skills/codereviewskill.js'
import { GitSkill } from './skills/gitskill.js'
import { CommandRegistry } from './commands/commandregistry.js'
import { CommandParser } from './commands/commandparser.js'
import { HelpCommand } from './commands/helpcommand.js'
import { SkillCommand } from './commands/skillcommand.js'

const skillManager = new SkillManager()
skillManager.registerBuiltin(new CodeReviewSkill())
skillManager.registerBuiltin(new GitSkill())
await skillManager.loadFromDisk()

const toolRegistrar = new ToolRegistrar()
toolRegistrar.registerTool(new (await import('./tools/readtool')).ReadTool())
toolRegistrar.registerTool(new (await import('./tools/writetool')).WriteTool())
toolRegistrar.registerTool(new (await import('./tools/listdirtool')).ListDirTool())
toolRegistrar.registerTool(new (await import('./tools/bashtool')).BashTool())
toolRegistrar.registerTool(new (await import('./tools/agenttool')).AgentTool())
toolRegistrar.registerTool(new (await import('./tools/builtin/planneragenttool')).PlannerAgentTool())
toolRegistrar.registerTool(new (await import('./tools/builtin/generatortool')).GeneratorTool())
toolRegistrar.registerTool(new (await import('./tools/builtin/verifiertool')).VerifierTool())
toolRegistrar.registerTool(new (await import('./tools/memorytool')).MemoryTool())
toolRegistrar.registerTool(new (await import('./tools/useskilltool')).UseSkillTool(skillManager))
toolRegistrar.registerTool(new (await import('./tasks/tasktool')).TaskTool())

const client = createClient()

const baseSystemPrompt = getSystemPrompt()
console.log('[agent] System prompt loaded\n' + baseSystemPrompt)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve))
}

const commandRegistry = new CommandRegistry()
commandRegistry.register(new HelpCommand(commandRegistry))
commandRegistry.register(new SkillCommand(skillManager, rl))
commandRegistry.register(new (await import('./tasks/taskcommand')).TaskCommand())
const commandParser = new CommandParser(commandRegistry)

const hookManager = new HookManager()
hookManager.register(new LoggerHook())
hookManager.register(new PermissionHook(rl))

async function executeTool(name: string, input: unknown, skipHooks: boolean = false): Promise<string> {
  const args = input as Record<string, string>
  try {
    if (!skipHooks) {
      const preResult = await hookManager.runOnToolCall({ toolName: name, toolInput: input })
      if (preResult.action === 'block') {
        return `Permission denied: ${preResult.reason}`
      }
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

const MAX_TURNS = 20
const MEMORY_CONSOLIDATE_THRESHOLD = 100

/** 记忆整理：将对话历史分类归档到各记忆文件，并更新 INDEX.md */
async function consolidateMemory(conversationHistory: Anthropic.MessageParam[]): Promise<boolean> {
  console.log('[agent] Memory 整理...')

  // 快照：记录整理前的 INDEX.md 内容
  const indexBefore = readCategory('index')

  const historyText = conversationHistory
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

  // 检查 INDEX.md 是否被更新（update_index 是整理的最后一步）
  const indexAfter = readCategory('index')
  if (indexAfter === indexBefore) {
    console.log('[agent] Memory 整理失败：INDEX.md 未被更新，保留当前上下文')
    return false
  }
  console.log('[agent] Memory 整理完毕')
  return true
}

/** 将记忆片段注入 system prompt */
function buildSystemPromptWithMemory(memoryFragment: string): string {
  const base = memoryFragment
    ? `${baseSystemPrompt}\n\n## 相关记忆\n${memoryFragment}`
    : baseSystemPrompt
  return `${base}${skillManager.buildPromptFragment()}`
}

async function agentLoop(context: { messages: Anthropic.MessageParam[]; systemPrompt: string }): Promise<void> {
  const { messages, systemPrompt } = { ...context }

  await runAgentLoopStream({
    client,
    model: 'claude-sonnet-4-6',
    system: systemPrompt,
    tools: toolRegistrar.getAllTools(),
    messages,
    maxTurns: MAX_TURNS,
    executeTool,
    onText: delta => process.stdout.write(delta),
  })
  process.stdout.write('\n')
}

function printBanner() {
  console.log(`
    / \\__
   (    @\\___
   /         O
  /   (_____/
 /_____/   U

  🐶 myagent — Ready. Type a task (ctrl+c to exit).
`)
}

async function repl() {
  printBanner()

  // 不再启动时加载所有记忆，改为每轮动态召回
  const messages: Anthropic.MessageParam[] = []

  while (true) {
    let input: string
    try {
      input = await question('> ')
    } catch {
      break
    }
    if (!input.trim()) continue

    if (commandParser.isCommand(input)) {
      await commandParser.dispatch(input)
      continue
    }

    messages.push({ role: 'user', content: input })

    // ── 动态召回与当前 query 相关的记忆 ──
    console.log('[agent] 召回相关记忆...')
    const relevantMemory = await recallRelevantMemory(input)
    if (relevantMemory) {
      console.log('[agent] ✓ 找到相关记忆，注入 system prompt')
    } else {
      console.log('[agent] - 未找到相关记忆')
    }
    const systemPrompt = buildSystemPromptWithMemory(relevantMemory)

    try {
      await agentLoop({ messages, systemPrompt })
    } catch (err) {
      console.error(`[agent] Error: ${err}`)
      // 回滚刚加入的 user 消息，避免下一轮发送残缺的对话历史
      messages.pop()
      continue
    }

    // 当 messages 积累超过阈值时触发记忆整理
    if (messages.length >= MEMORY_CONSOLIDATE_THRESHOLD) {
      const consolidated = await consolidateMemory(messages)
      if (consolidated) {
        // 整理成功后清空对话历史（记忆已归档到文件），下一轮再从文件召回
        messages.length = 0
      }
    }
  }
  rl.close()
}

repl()
