import { TuiBridge } from './tui/bridge.js'
import { App } from './tui/App.js'
import React from 'react'
import { render } from 'ink'

// Override console.log/error before any other module code runs (static imports are
// hoisted but their *function bodies* only run when called, so this is safe).
// Originals are kept so debug (headless) mode can restore them — its progress
// logging legitimately needs stderr.
const bridge = new TuiBridge()
const originalConsoleLog = console.log.bind(console)
const originalConsoleError = console.error.bind(console)
console.log = (...args: unknown[]) => {
  bridge.emitMessage('system', args.map(String).join(' '))
}
console.error = (...args: unknown[]) => {
  bridge.emitMessage('system', args.map(arg => {
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`
    return String(arg)
  }).join(' '))
}

// ── 全局错误处理器：防止 unhandledRejection / uncaughtException 静默退出 ──
// Node.js v15+ 默认在 unhandledRejection 时以 code 1 退出，但我们希望
// 在 TUI 中显示错误而非让进程悄无声息地消失。
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack}` : String(reason)
  bridge.emitMessage('system', `❌ Unhandled Rejection:\n${msg}`)
  // Also write to ORIGINAL stderr so headless / piped runs surface the failure.
  originalConsoleError('[myagent] Unhandled Rejection:', reason)
})

process.on('uncaughtException', (err: Error) => {
  const msg = `${err.name}: ${err.message}\n${err.stack?.split('\n').slice(0, 6).join('\n')}`
  bridge.emitMessage('system', `❌ Uncaught Exception:\n${msg}`)
  originalConsoleError('[myagent] Uncaught Exception:', err)
  // uncaughtException 后进程状态不可靠，延迟退出让用户看到错误
  setTimeout(() => process.exit(1), 2000)
})

import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js'
import { createClient } from './client.js'
import { getSystemPrompt } from './prompt/prompt.js'
import { readCategory } from './memory/memory.js'
import { recallRelevantMemory } from './memory/recall.js'
import { runAgentLoopStream, UsageAccum, type RunAgentLoopResult } from './utils/runagent.js'
import { compactMessages, microcompactMessages, estimateTokens, MICRO_COMPACT_TOKEN_THRESHOLD, COMPACT_TOKEN_THRESHOLD } from './utils/compact.js'
import { ToolRegistrar } from './tools/toolregistrar.js'
import { validateInput, validateOutput } from './tools/validator.js'
import { MessageQueue } from './messagequeue.js'
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
import { BgCommand } from './commands/bgcommand.js'
import { VoiceCommand } from './commands/voicecommand.js'
import { ModelCommand } from './commands/modelcommand.js'
import { advisorConfig } from './llm/advisor-config.js'
import { AdvisorCommand } from './commands/advisorcommand.js'
import { GoalCommand } from './commands/goalcommand.js'
import { GoalHook } from './hooks/goalhook.js'
import { modelConfig } from './llm/model-config.js'
import { ttsService } from './voice/tts.js'
import { SchedulerCommand } from './scheduler/schedulercommand.js'
import { Scheduler } from './scheduler/scheduler.js'
import { MCPManager } from './mcp/mcpmanager.js'
import { handleMCPCommand } from './commands/mcpcommand.js'
import { todoManager } from './todos/todomanager.js'
import { attachmentQueue } from './attachment/queue.js'
import { taskRegistry } from './team/taskRegistry.js'
import { Mailbox, formatMail } from './mailbox/mailbox.js'
import {
  saveBackgroundResult,
  buildBgNotification,
  cleanOldResults,
} from './utils/backgroundStorage.js'
import { bgManager } from './utils/backgroundManager.js'
import { TranscriptRecorder, loadLatestCheckpoint } from './utils/transcript.js'
import type { ChatMessage } from './tui/types.js'
import { sessionState } from './state/sessionState.js'
import { setAutoModeChangeHandler } from './state/onChangeAppState.js'
import { AppStateProvider, appStateStore } from './state/AppStateProvider.js'

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
toolRegistrar.registerTool(new (await import('./tools/createteamtool.js')).CreateTeamTool())
toolRegistrar.registerTool(new (await import('./tools/sendmailtool.js')).SendMailTool('main'))
toolRegistrar.registerTool(new (await import('./tools/checkmailtool.js')).CheckMailTool('main'))
toolRegistrar.registerTool(new (await import('./tools/gitworktreetool.js')).GitWorktreeTool())

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

// 当前 runTurn 的 AbortSignal（供 AgentTool 传递给 sub-agent 内部循环，由 turn.ts 写入）
export const turnState = {
  currentAbortSignal: undefined as AbortSignal | undefined,
}

// ── MCP Manager ───────────────────────────────────────────────────────────────
const mcpManager = new MCPManager()
mcpManager.setRegistrar(toolRegistrar)
mcpManager.onStatusChange((infos) => bridge.emitMcpStatus(infos))
await mcpManager.startAll()

// 清理超过 24 小时的过期后台结果文件
cleanOldResults()

// ── Agent state ───────────────────────────────────────────────────────────────
export const MAX_TURNS = 1000
let initialTuiMessages: ChatMessage[] = []

// ── Transcript Recorder ──────────────────────────────────────────────
const transcriptRecorder = new TranscriptRecorder()

// 检查 --continue / -c 标志，从上一个 session 恢复会话
// 注意：npm run agent -c 会被 npm 自身拦截（-c 是 npm 的配置标志），
// 不会传到 agent.ts。请使用 npm run agent -- -c 或 npm run continue。
// 环境变量 MYAGENT_CONTINUE=1 可作为备选（适用于 docker/CI 等场景）。
const shouldContinue = process.argv.includes('--continue') || process.argv.includes('-c') || process.env.MYAGENT_CONTINUE === '1'
if (shouldContinue) {
  const checkpoint = loadLatestCheckpoint()
  if (checkpoint) {
    sessionState.hydrate(checkpoint.messages, checkpoint.sessionId)
    console.log(`[continue] Loaded ${checkpoint.messages.length} messages from ${checkpoint.sessionId}`)
    // 将恢复的消息转换为 ChatMessage[] 供 TUI 显示历史
    initialTuiMessages = convertMessagesForTui(checkpoint.messages)
  } else {
    console.log('[continue] No previous session found, starting fresh')
  }
}

/**
 * 将 Anthropic.MessageParam[] 转换为 TUI 可显示的 ChatMessage[]。
 *
 * 设计意图：
 *   - 保留用户消息（role='user'）中有文本内容的（真正用户输入）
 *   - 保留 AI 回复（role='assistant'）中有推理文本的（跳过纯 tool_use 的回复）
 *   - 跳过 tool_result 消息（Anthropic API 中 role='user'，但内容是工具输出，无用户输入文本）
 *   - 首条插入一句摘要，让用户知道这是历史恢复
 */
function convertMessagesForTui(msgs: Anthropic.MessageParam[]): ChatMessage[] {
  const result: ChatMessage[] = []
  let seq = 0

  for (const msg of msgs) {
    // 跳过 tool_result 消息（role='user' 但内容是工具输出）
    if (msg.role === 'user') {
      const content = msg.content
      if (Array.isArray(content)) {
        // tool_result 消息没有 text block
        const hasTextBlock = content.some(c => c.type === 'text')
        if (!hasTextBlock) continue
      } else if (typeof content === 'string' && !content.trim()) {
        continue
      }
    }

    // 跳过 assistant 消息中纯 tool_use 的（无文本块）
    if (msg.role === 'assistant') {
      const content = msg.content
      if (Array.isArray(content)) {
        const hasTextBlock = content.some(c => c.type === 'text')
        if (!hasTextBlock) continue
      } else if (typeof content === 'string' && !content.trim()) {
        continue
      }
    }

    const text = extractTextFromContent(msg.content)
    if (text.trim()) {
      seq++
      const role = msg.role === 'assistant' ? 'agent' as const : 'user' as const
      result.push({ id: `hist-${seq}`, role, content: text.trim() })
    }
  }

  if (result.length > 0) {
    const summary = `── 已恢复上次会话 (${result.length} 轮对话) ──`
    result.unshift({ id: 'hist-summary', role: 'system', content: summary })
  }

  return result
}

/** 从 Anthropic 消息 content（string | ContentBlock[]）中提取纯文本。 */
function extractTextFromContent(content: string | Anthropic.ContentBlockParam[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

transcriptRecorder.initSession(sessionState.continuedFromSession)

// ── -c 恢复后立即保存初始 checkpoint ──────────────────────────────
// 防止用户在不发消息的情况下退出，导致新会话没有 checkpoint，
// 下次 -c 会跳过新会话、又加载旧会话的 checkpoint。
if (shouldContinue && sessionState.messages.length > 0) {
  transcriptRecorder.recordCheckpoint(sessionState.messages)
}

// ── 启动完成，清理初始化阶段的 Attachment 噪声 ──────────────────────────
attachmentQueue.clear()

// ── 进程退出时关闭 transcript session ─────────────────────────────
// 同时监听 beforeExit、SIGINT、SIGTERM 三个退出路径：
//   - beforeExit   → Node.js 事件循环自然退出时触发
//   - SIGINT       → Ctrl+C 终端中断（Ink 走这个路径）
//   - SIGTERM      → kill 命令或进程管理器终止
// 三方汇合确保 .closed 标记一定写入，下次 -c 才能恢复。
function cleanupTranscript(): void {
  try { transcriptRecorder.closeSession() } catch { /* ignore */ }
}
process.on('beforeExit', cleanupTranscript)
process.on('SIGINT', () => { cleanupTranscript(); Mailbox.stopWatching('main'); process.exit(0) })
process.on('SIGTERM', () => { cleanupTranscript(); Mailbox.stopWatching('main'); process.exit(0) })

// AgentTool 需要 client / executeTool / emitLine / transcriptRecorder —— 这些此时才有，在这里注入
import type { BackgroundAgentResult } from './tools/agenttool.js'
agentTool.setExecutionContext({
  client,
  advisorClient: advisorConfig.available ? advisorConfig.client! : undefined,
  executeTool: (name, input) => executeTool(name, input),
  emitLine: line => bridge.emitMessage('system', line),
  transcriptRecorder,
  onSubAgentDelta: (name, delta) => bridge.emitSubAgentDelta(name, delta),
  onSubAgentHeartbeat: (name, elapsedMs) => bridge.emitSubAgentHeartbeat(name, elapsedMs),
  onSubAgentStart: (name, description, agentType) => bridge.emitSubAgentStart(name, description, agentType),
  onSubAgentProgress: (name, toolUseCount, tokenCount, lastActivity) => bridge.emitSubAgentProgress(name, toolUseCount, tokenCount, lastActivity),
  onSubAgentDone: (name, status, error) => bridge.emitSubAgentDone(name, status, error),
  onBackgroundAgentResult: (result: BackgroundAgentResult) => {
    // 后台 sub-agent 完成 → 推 XML 通知进 messages
    const relativePath = `.myagent/background/${result.taskId}.md`
    const notification = result.status === 'completed'
      ? buildBgNotification(result.taskId, 'completed', result.text.slice(0, 200), relativePath)
      : buildBgNotification(result.taskId, 'failed', result.taskId, relativePath, result.error)
    sessionState.appendMessage({ role: 'user', content: notification })
    bridge.emitMessage('system', `[bg:${result.name}] ${result.status === 'completed' ? '√' : '✗'} taskId=${result.taskId}`)

    // 注意：不在此处 drain 邮箱。teammate 的 send_mail 已通过 deliverIfNew
    // → subscribeMainMailbox → enqueueMainMailboxWake → processQueue 链路
    // 触发新 turn 处理邮件。此处若 eager drain 会导致邮件被消费但无 turn 处理。
  },
})
const hookManager = new HookManager()
hookManager.register(new LoggerHook(bridge))
const permissionHook = new PermissionHook(prompt => bridge.askPermission(prompt), toolRegistrar)
const autoPermissionAgent = new AutoPermissionAgent(client)
hookManager.register(permissionHook)
hookManager.register(new RetrospectiveHook(client, skillManager, bridge, 30))
hookManager.register(new GoalHook(agentTool, enqueueUserMessage, bridge))

// 初始时立即同步 auto mode 状态（默认开启），无需等待 toggle 事件
permissionHook.setAutoMode(bridge.autoMode, autoPermissionAgent)
setAutoModeChangeHandler(enabled => {
  permissionHook.setAutoMode(enabled, autoPermissionAgent)
})

// ── Todo Manager → Bridge ─────────────────────────────────────────────────
todoManager.on('update', (snapshot) => {
  bridge.emitTodoPlanUpdate(snapshot)
})

// ── Task Registry → Bridge ────────────────────────────────────────────────
taskRegistry.on('change', (tasks) => {
  bridge.emitTeammateTasks(tasks)
})

// ── ! 命令：执行 bash / !mcp 并推入 messages (Claude Code 模式) ───
// 复用 toolRegistry 中的 BashTool（和 LLM 调用的同个工具），而非另起 execSync。
// 结果以 XML 标签格式推入 messages 供后续 LLM 回合引用，本身不触发 LLM query。
// !mcp 命令被拦截路由到 MCP 命令处理器。
//
// Escape `<` so user input or tool output can't smuggle a fake closing tag
// (e.g. `</bash-input>...` injecting follow-up instructions). `<` → `&lt;`
// keeps the text human-readable to the LLM while preventing tag confusion.
export function escapeForTag(text: string): string {
  return text.replace(/</g, '&lt;')
}

export async function executeTool(name: string, input: unknown, skipHooks = false): Promise<string> {
  const args = input as Record<string, string>
  try {
    const tool = toolRegistrar.getTool(name)
    if (!tool) return 'Unknown tool'

    // Validate the LLM-supplied input against the tool's zod schema before
    // dispatch. Returning a structured error lets the model see what went wrong
    // and self-correct instead of crashing inside the tool.
    const inputCheck = validateInput(tool, input)
    if (!inputCheck.ok) return `Error: ${inputCheck.error}`

    if (!skipHooks) {
      const pre = await hookManager.runOnToolCall({ toolName: name, toolInput: input })
      if (pre.action === 'block') return `Permission denied: ${pre.reason}`
    }
    const result = await tool.execute(args, turnState.currentAbortSignal)

    // Output validation: catches contract drift in our own tools (LLM gets the
    // wrong-shape data, downstream parsers blow up). Don't block the response —
    // the LLM can still try to use it — but log loudly so dev sees the regression.
    const outputCheck = validateOutput(tool, result)
    if (!outputCheck.ok) {
      console.error(`[validator] ${outputCheck.error}`)
    }

    if (!skipHooks) {
      await hookManager.runOnToolResult({ toolName: name, toolInput: input, toolResult: result })
    }
    return result
  } catch (err) {
    return `Error: ${err}`
  }
}

// ── Message Queue ────────────────────────────────────────────────────────────
// 用户自然语言 prompt 入队，由 runAgentLoopStream 在工具执行后 / end_turn 前 drain。
// ! 和 / 命令不入队，直接执行。
const messageQueue = new MessageQueue()
export function enqueueUserMessage(msg: string): void {
  messageQueue.enqueue(msg)
}
export function enqueueMainMailboxWake(): void {
  originalConsoleError(`[enqueueMainMailboxWake] pushing mailbox-wake to queue (queue length before: ${messageQueue.length})`)
  messageQueue.enqueueMailboxWake('main')
  originalConsoleError(`[enqueueMainMailboxWake] queue length after: ${messageQueue.length}`)
}
export function subscribeQueue(listener: () => void): () => void {
  return messageQueue.subscribe(listener)
}
export function getQueueLength(): number {
  return messageQueue.length
}
export function drainQueue(): string | undefined {
  while (true) {
    
    const item = messageQueue.dequeueItem()
    if (!item) {
      break
    }
    if (item.kind === 'user') return item.value
  }

  // drainMailbox 由 runAgentLoopStream 统一 drain 阶段调用，
  // 不在此处嵌套调用（否则会触发两次，且修复不标记已读后会导致重复推送）。
  return undefined
}

/**
 * 已通过 drainMailbox 注入过 LLM 上下文的邮件 ID 集合。
 * 防止同一封未读邮件在多轮 turn 中重复注入，造成 TUI 重复显示。
 * LLM 后续通过 check_mail mode=pop 消费邮件时，
 * Mailbox.markRead 会将邮件移出 inbox，届时不再需要此去重。
 */
const drainedMailIds = new Set<string>()

/**
 * drainMailbox — 扫描指定 agent 邮箱中的未读邮件，格式化为文本推入 LLM 上下文。
 *
 * @param agentId 要扫描的 agent ID，默认 'main'（供主 agent 使用）。
 *                teammate 应传 undefined 跳过 drain（teammate 使用 check_mail 工具消费邮件）。
 * @returns 格式化后的邮件文本，邮箱为空或 agentId 为 undefined 时返回 undefined
 *
 * ⚠️ 重要：返回的文本包含一条强制行动指令，LLM 必须主动处理这些邮件，
 * 而非静默 end_turn。这是为了防止 teammate 的请求/问候被忽略。
 *
 * 去重机制：模块级 drainedMailIds Set 记录已注入过的邮件 ID，
 * 同一封邮件不会在多轮 turn 中重复注入。邮件被 LLM 通过 check_mail
 * mode=pop 消费后移出 inbox，但即便未消费也不会重复出现。
 */
export function drainMailbox(agentId?: string): string | undefined {
  if (!agentId) return undefined
  originalConsoleError(`[drainMailbox] scanning ~/.myagent/mailbox/${agentId}/ for unread mails...`)
  const allMails = Mailbox.list(agentId)
  originalConsoleError(`[drainMailbox] found ${allMails.length} unread mail(s)`)
  if (allMails.length === 0) return undefined

  // 过滤已注入过的邮件，只保留新邮件
  const newMails = allMails.filter(m => !drainedMailIds.has(m.id))
  if (newMails.length === 0) {
    originalConsoleError(`[drainMailbox] all ${allMails.length} mail(s) already drained, skipping`)
    return undefined
  }

  // 记录新邮件 ID，防止下轮重复注入
  for (const m of newMails) {
    drainedMailIds.add(m.id)
  }

  originalConsoleError(`[drainMailbox] ${newMails.length} new mail(s) to inject (${allMails.length - newMails.length} already seen)`)

  const formatted = newMails.map(formatMail).join('\n\n---\n\n')

  // ⚠️ 不在此处标记已读。标记已读的职责交给 LLM：
  // LLM 用 check_mail mode=pop 逐封消费（pop = 读取 + 标记已读），
  // 处理完一封再 pop 下一封。这样如果 LLM 中途退出/出错，
  // 未处理的邮件仍然留在 inbox 中，不会丢失。
  // drainedMailIds 去重集合保证即使邮件未被消费也不会重复注入。

  const header = `[New Mail — ${newMails.length} unread from teammates]`
  const instruction = [
    '',
    '⚠️ 你必须逐封处理以上邮件：',
    '1. 用 check_mail mode=pop 取出一封（pop 会标记已读，所以处理完再 pop 下一封）',
    '2. 根据邮件内容决定行动：用 send_mail 回复，或执行请求的任务',
    '3. 重复直到 check_mail 返回 "(empty)"',
    '不要静默忽略任何邮件。',
  ].join('\n')

  return `${header}\n${instruction}\n\n${formatted}`
}

// ── Commands ──────────────────────────────────────────────────────────────────
const commandRegistry = new CommandRegistry()
commandRegistry.register(new HelpCommand(commandRegistry))
commandRegistry.register(new SkillCommand(skillManager, prompt => bridge.askQuestion(prompt)))
commandRegistry.register(new TaskCommand())
// RetrospectiveCommand 需要访问 messages，传一个 getter 函数
commandRegistry.register(new RetrospectiveCommand(client, () => sessionState.messages, skillManager, bridge))
// TokenStatsCommand 需要访问 lastUsage 和 messages，传 getter 函数
commandRegistry.register(new TokenStatsCommand(() => sessionState.lastUsage, () => sessionState.messages))
commandRegistry.register(new BgCommand())
commandRegistry.register(new SchedulerCommand())
commandRegistry.register(new VoiceCommand())
commandRegistry.register(new ModelCommand(qs => bridge.askChoice(qs)))
commandRegistry.register(new AdvisorCommand(qs => bridge.askChoice(qs)))
commandRegistry.register(new GoalCommand())
commandRegistry.register(new (await import('./commands/teamcommand.js')).TeamCommand(enqueueUserMessage))
const commandParser = new CommandParser(commandRegistry)

/**
 * Build the system prompt as TWO segments so prompt cache stays warm:
 *   - stable: base prompt + tools section + agent registry description
 *     (only changes when code/agents change)
 *   - dynamic: recalled memory + active skills (changes per user input / skill toggle)
 * Only the stable segment carries cache_control. The dynamic segment is appended
 * uncached so flipping memory/skills doesn't invalidate the cache.
 */
export function buildSystemSegments(memoryFragment: string): Anthropic.TextBlockParam[] {
  const agentSection = agentRegistry.describeForPrompt() || undefined
  const stableText = getSystemPrompt(agentSection)

  const dynamicParts: string[] = []
  if (memoryFragment) dynamicParts.push(`## 相关记忆\n${memoryFragment}`)
  const skillFragment = skillManager.buildPromptFragment()
  if (skillFragment) dynamicParts.push(skillFragment.trimStart())

  const segments: Anthropic.TextBlockParam[] = [
    { type: 'text', text: stableText, cache_control: { type: 'ephemeral' } },
  ]
  if (dynamicParts.length > 0) {
    segments.push({ type: 'text', text: dynamicParts.join('\n\n') })
  }
  return segments
}

export async function compactIfNeeded(): Promise<void> {
  const tokenCount = sessionState.lastUsage ? sessionState.lastUsage.inputTokens : estimateTokens(sessionState.messages)

  if (tokenCount >= COMPACT_TOKEN_THRESHOLD) {
    bridge.emitCompacting('start', `${tokenCount.toLocaleString()} tokens`)
    const compacted = await compactMessages(client, modelConfig.getCurrent(), sessionState.messages)
    sessionState.replaceMessages(compacted)
    sessionState.setUsage(null)
    bridge.emitUsageReset()
    bridge.emitCompacting('done', `${tokenCount.toLocaleString()} tokens → ${sessionState.messages.length} 条消息`)
    transcriptRecorder.recordCompact(tokenCount, sessionState.messages.length)
  } else if (tokenCount >= MICRO_COMPACT_TOKEN_THRESHOLD) {
    const freed = microcompactMessages(sessionState.messages)
    if (freed > 0) {
      sessionState.setUsage(null)
      bridge.emitUsageReset()
      bridge.emitCompacting('micro', `释放约 ${freed.toLocaleString()} tokens`)
    }
  }
}

/**
 * Extract plain text from user content for memory recall (strip attachments).
 */
export function extractRecallText(content: string | Array<ContentBlockParam | Anthropic.TextBlockParam>): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

// ── Background helpers ────────────────────────────────────────────────────────

/**
 * 从 fork 的消息历史中提取后台任务描述。
 * 取第一条 user message 的文本内容（前 100 字符）。
 */
export function extractBgDescription(forkedMessages: Anthropic.MessageParam[]): string {
  for (const msg of forkedMessages) {
    if (msg.role !== 'user') continue
    const content = msg.content
    if (typeof content === 'string') {
      const trimmed = content.trim()
      return trimmed.length > 100 ? trimmed.slice(0, 97) + '…' : trimmed
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text.trim()) {
          const text = block.text.trim()
          return text.length > 100 ? text.slice(0, 97) + '…' : text
        }
      }
    }
  }
  return 'background task'
}

/**
 * 从后台结论文本中提取一行摘要。
 * - 如果结论为空 → 使用 description
 * - 如果结论有内容 → 取第一段的第一行（前 200 字符）
 */
export function summarizeConclusion(conclusion: string, fallback: string): string {
  if (!conclusion.trim()) return fallback
  const firstLine = conclusion.split('\n')[0]?.trim() ?? ''
  if (!firstLine) return fallback
  return firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine
}

// ── 导出供 agent.ts 和 turn.ts 使用 ───────────────────────────────────────────
export {
  bridge,
  originalConsoleLog,
  originalConsoleError,
  client,
  toolRegistrar,
  hookManager,
  permissionHook,
  autoPermissionAgent,
  sessionState,
  transcriptRecorder,
  agentTool,
  skillManager,
  agentRegistry,
  messageQueue,
  attachmentQueue,
  bgManager,
  ttsService,
  modelConfig,
  mcpManager,
  commandParser,
  commandRegistry,
  initialTuiMessages,
  shouldContinue,
}
