import Anthropic from '@anthropic-ai/sdk'
import { runAgentLoopStream, type UsageAccum } from '../utils/runagent.js'
import { ToolRegistrar } from '../tools/toolregistrar.js'
import { Tool } from '../tools/tool.js'
import { extractLastText } from '../utils/agentutils.js'
import { AgentDefinition, AgentRunContext } from './definition.js'
import { modelConfig } from '../llm/model-config.js'
import { Mailbox, type Mail } from '../mailbox/mailbox.js'
import { teammateMailPriority } from '../tools/checkmailtool.js'

const DEFAULT_MAX_TURNS = 20

/**
 * 跑一个 sub agent。input 由 caller 传进来，formatUserMessage / extraTools
 * 由 definition 决定。返回 last assistant text（finalize 可覆盖）。
 */
export async function runAgent(
  def: AgentDefinition,
  args: Record<string, unknown>,
  ctx: AgentRunContext,
): Promise<string> {
  // ── 1. 组装该 agent 可用的工具 ─────────────────────────────────────────
  const subRegistrar = new ToolRegistrar()
  for (const toolName of def.tools) {
    const tool = ctx.toolRegistrar.getTool(toolName)
    if (!tool) {
      throw new Error(`Agent "${def.name}" requires unknown tool "${toolName}"`)
    }
    subRegistrar.registerTool(tool)
  }

  const extras: Tool[] = def.extraTools ? await def.extraTools(ctx, args) : []
  for (const t of extras) subRegistrar.registerTool(t)

  // ── 2. system prompt ─────────────────────────────────────────────────
  const system = typeof def.systemPrompt === 'function'
    ? await def.systemPrompt(args, ctx)
    : def.systemPrompt

  // ── 3. user message ──────────────────────────────────────────────────
  const userText = def.formatUserMessage
    ? await def.formatUserMessage(args, ctx)
    : String(args.task ?? '')
  if (!userText) {
    return `Error: agent "${def.name}" got empty user message`
  }

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userText }]

  // ── Transcript recording ──────────────────────────────────────────────
  const recorder = ctx.transcriptRecorder
  const recorderAgentId = ctx.agentId ?? def.name
  const recorderParentId = ctx.parentAgentId ?? ctx.source ?? 'main'
  let latestUsage: UsageAccum = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  if (recorder) {
    recorder.pushAgentContext(recorderAgentId, recorderParentId)
    recorder.recordUserInput(userText)
    recorder.recordSubAgentStart(def.agentType ?? def.name, String(args.task ?? ''))
  }

  // ── 4. 工具调用计数器，用于进度回调 ─────────────────────────────────
  let toolUseCount = 0
  let currentActivity: string | undefined
  const updateProgress = () => {
    ctx.onSubAgentProgress?.(def.name, toolUseCount, 0, currentActivity)
  }

  // ── 5. 跑循环 ────────────────────────────────────────────────────────
  const prefix = `[${def.name}]`
  const onText = (delta: string) => {
    // 子 agent 的流式文本只走 onSubAgentDelta → TUI 工具卡 liveOutput，
    // 不走 emitLine → 系统消息（否则会同时在聊天消息区和工具卡中出现）。
    ctx.onSubAgentDelta?.(def.name, delta)
  }
  ctx.emitLine(`${prefix} ← invoked by ${ctx.source}`)

  const subExecuteTool = async (name: string, input: unknown): Promise<string> => {
    // Agent-only 工厂工具优先（不会出现在主 toolRegistrar 中），直接走自己的 execute
    const local = extras.find(t => t.name === name)
    let result: string
    if (local) {
      try { result = await local.execute(input as Record<string, string>, ctx.signal) }
      catch (err) { result = `Error: ${err}` }
    } else {
      // 全局工具走主流程，这样 hooks / 权限继续生效
      result = await ctx.executeTool(name, input)
    }
    // 每次工具调用后更新进度
    toolUseCount++
    currentActivity = `Running ${name}…`
    updateProgress()
    return result
  }

  // advisor agent 使用独立的 Claude 原生 client（ctx.advisorClient），其余 agent 走主 client
  // 注意：当 advisorClient 不可用时回退到主 client，model 也必须跟着回退，
  // 否则会用 Claude 模型名去请求 DeepSeek API，导致静默失败。
  const useAdvisorClient = def.name === 'advisor' && ctx.advisorClient
  const client = useAdvisorClient ? (ctx.advisorClient ?? ctx.client) : ctx.client
  const model = useAdvisorClient
    ? (typeof def.model === 'function' ? def.model() : (def.model ?? modelConfig.getCurrent()))
    : modelConfig.getCurrent()

  // ── teammate 邮箱轮询 + keepAlive ───────────────────────────────────
  // 三层机制确保 teammate 长期存活、优先处理用户/leader 消息：
  //   1. drainMailbox — 每轮 LLM 结束后立即检查邮箱（快速路径），用优先级排序
  //   2. waitForEvent  — 当 drain 全部为空时，进入轮询等待（每秒查一次）
  //   3. keepAlive     — 让 runAgentLoopStream 不退出，而是一直等到 close 或 signal
  const isTeammate = def.agentType === 'teammate'
  const teammateMailboxId = isTeammate ? String(args.agent_id ?? '') : ''
  const leaderId = isTeammate ? String(args.leader_id ?? 'leader') : ''
  let closeReceived = false

  // 优先级 pop：用户消息 > close > leader > peer，同优先级 FIFO
  const popByPriority = (): Mail | null => {
    const all = Mailbox.list(teammateMailboxId)
    if (all.length === 0) return null
    all.sort((a, b) => {
      const pa = teammateMailPriority(a, leaderId)
      const pb = teammateMailPriority(b, leaderId)
      if (pa !== pb) return pa - pb
      return a.created_at.localeCompare(b.created_at)
    })
    const m = all[0]
    Mailbox.markRead(teammateMailboxId, m.id)
    return m
  }

  const formatMailForAgent = (m: Mail): string =>
    `📬 新邮件 [${m.kind}] from ${m.from}: ${m.subject}\n\n${m.body}`

  const drainMailbox = isTeammate
    ? () => {
        const m = popByPriority()
        if (!m) return undefined
        if (m.kind === 'close') closeReceived = true
        return formatMailForAgent(m)
      }
    : undefined

  const waitForEvent = isTeammate
    ? async (): Promise<string | undefined> => {
        // 已收到 close → 不再等待，让 worker 正常退出
        if (closeReceived) return undefined
        // 轮询等待新邮件（每秒一次）
        while (!ctx.signal?.aborted) {
          const m = popByPriority()
          if (m) {
            if (m.kind === 'close') closeReceived = true
            return formatMailForAgent(m)
          }
          await new Promise(r => setTimeout(r, 1000))
        }
        return undefined
      }
    : undefined

  try {
    await runAgentLoopStream({
      client,
      model,
      system,
      tools: subRegistrar.getAllTools(),
      messages,
      maxTurns: def.maxTurns ?? DEFAULT_MAX_TURNS,
      executeTool: subExecuteTool,
      parallelSafeTools: subRegistrar.getParallelSafeNames(),
      onText,
      signal: ctx.signal,
      drainMailbox,
      keepAlive: isTeammate,
      waitForEvent,
      onLLMRequest: recorder
        ? (model, turn, msgs) => recorder.recordLLMRequest(model, turn, msgs)
        : undefined,
      onTurnEnd: recorder
        ? (text, msgs) => {
            if (text) recorder.recordLLMResponseEnd(text, latestUsage, undefined)
            recorder.recordCheckpoint(msgs)
          }
        : undefined,
      onToolStart: recorder
        ? (callId, name, input) => recorder.recordToolStart(callId, name, input)
        : undefined,
      onToolEnd: recorder
        ? (callId, name, input, output) => recorder.recordToolEnd(callId, name, input, output)
        : undefined,
      onUsage: stats => {
        latestUsage = stats
      },
    })

    const lastText = extractLastText(messages)
    const result = def.finalize ? await def.finalize(messages, lastText, ctx, args) : (lastText || `(agent "${def.name}" produced no text output)`)

    if (recorder) {
      recorder.recordSubAgentEnd(def.agentType ?? def.name, undefined, toolUseCount)
    }
    return result
  } catch (err) {
    if (recorder) {
      const msg = err instanceof Error ? err.message : String(err)
      recorder.recordSubAgentEnd(def.agentType ?? def.name, msg, toolUseCount)
    }
    throw err
  } finally {
    if (recorder) {
      recorder.popAgentContext()
    }
  }
}
