import Anthropic from '@anthropic-ai/sdk'
import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import { createClient } from './client'

import { getSystemPrompt } from './prompt/prompt'
import { getMemoryPrompt, getUserMessage, MEMORY_FILE_PATH } from './memory/memory'
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


// 返回 true 表示 memory.md 被成功写入，false 表示整理失败
async function consolidateMemory(conversationHistory: Anthropic.MessageParam[]): Promise<boolean> {
  console.log('[agent] Memory 整理...')
  const contentBefore = fs.existsSync(MEMORY_FILE_PATH) ? fs.readFileSync(MEMORY_FILE_PATH, 'utf-8') : ''

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

  const contentAfter = fs.existsSync(MEMORY_FILE_PATH) ? fs.readFileSync(MEMORY_FILE_PATH, 'utf-8') : ''
  if (contentAfter === contentBefore) {
    console.log('[agent] Memory 整理失败：memory.md 未被写入，保留当前上下文')
    return false
  }
  console.log('[agent] Memory 整理完毕')
  return true
}

async function extractMemory(): Promise<string> {
  console.log('[agent] 提取记忆...')
  const userMessage = getUserMessage()
  if (!userMessage) {
    console.log('[agent] 没有用户记忆')
    return ''
  }
  console.log(userMessage.trim())
  console.log('[agent] 用户记忆提取完毕')
  return userMessage
}

function buildSystemPromptWithMemory(memory: string): string {
  const base = memory ? `${baseSystemPrompt}\n\n## 历史记忆\n${memory}` : baseSystemPrompt
  return `${base}${skillManager.buildPromptFragment()}`
}

async function agentLoop(context: { messages: Anthropic.MessageParam[]; systemPrompt: string }): Promise<Anthropic.MessageParam[] | null> {
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

  return messages
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

  const memory = await extractMemory()
  let context: { messages: Anthropic.MessageParam[]; systemPrompt: string } = {
    messages: [],
    systemPrompt: buildSystemPromptWithMemory(memory),
  }

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

    context.messages.push({ role: 'user', content: input })

    let history: Anthropic.MessageParam[] | null = null
    try {
      history = await agentLoop(context)
    } catch (err) {
      console.error(`[agent] Error: ${err}`)
      // 回滚刚加入的 user 消息，避免下一轮发送残缺的对话历史
      context.messages.pop()
      continue
    }

    // 当 messages 积累超过阈值时触发记忆整理
    // 用 messages.length 而不是 turnCount，避免 tool use 产生的额外消息导致计数对不上
    if (history && history.length >= MEMORY_CONSOLIDATE_THRESHOLD) {
      const consolidated = await consolidateMemory(history)
      if (consolidated) {
        const newMemory = await extractMemory()
        context = {
          messages: [],
          systemPrompt: buildSystemPromptWithMemory(newMemory),
        }
      }
    }
  }
  rl.close()
}

repl()
