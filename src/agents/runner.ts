import Anthropic from '@anthropic-ai/sdk'
import { runAgentLoopStream, type UsageAccum } from '../utils/runagent.js'
import { ToolRegistrar } from '../tools/toolregistrar.js'
import { Tool } from '../tools/tool.js'
import { extractLastText } from '../utils/agentutils.js'
import { AgentDefinition, AgentRunContext } from './definition.js'
import { modelConfig } from '../llm/model-config.js'
import { Mailbox, type Mail } from '../mailbox/mailbox.js'

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

  // ── teammate 邮箱信号 + keepAlive ───────────────────────────────────
  // 邮件消费策略：LLM 通过 check_mail(mode=pop) 独占消费，drainMailbox 不预 pop。
  // 三层机制确保 teammate 长期存活：
  //   1. check_mail  — LLM 轮询邮箱，pop 消费邮件（唯一消费路径）
  //   2. waitForEvent — drain 全部为空时，等待新邮件到达信号（只检测，不 pop）
  //   3. keepAlive    — 让 runAgentLoopStream 不退出，一直到 close 或 signal
  //
  // 例外：close 邮件由 waitForEvent 直接处理（pop + markRead），因为需要
  // 设置 closeReceived 标志来终止 keepAlive 循环。
  const isTeammate = def.agentType === 'teammate'
  const teammateMailboxId = isTeammate ? String(args.agent_id ?? '') : ''
  let closeReceived = false

  const formatMailForAgent = (m: Mail): string =>
    `📬 新邮件 [${m.kind}] from ${m.from}: ${m.subject}\n\n${m.body}`

  // teammate 不使用 drainMailbox 预 pop —— 邮件由 LLM 通过 check_mail 工具独占消费
  const drainMailbox = undefined

  const waitForEvent = isTeammate
    ? async (): Promise<string | undefined> => {
        while (!ctx.signal?.aborted && !closeReceived) {
          const all = Mailbox.list(teammateMailboxId)
          // close 邮件特殊处理：直接 pop + markRead，设置 closeReceived 终止循环
          const closeMail = all.find(m => m.kind === 'close')
          if (closeMail) {
            closeReceived = true
            Mailbox.markRead(teammateMailboxId, closeMail.id)
            return formatMailForAgent(closeMail)
          }
          // 其他邮件：只检测不 pop，返回唤醒消息让 LLM 用 check_mail 消费
          if (all.length > 0) {
            return '📬 New mail in your inbox — call check_mail(mode=pop) to read it.'
          }
          await Mailbox.waitForMail(teammateMailboxId, ctx.signal)
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
      maxTurns: isTeammate ? Infinity : (def.maxTurns ?? DEFAULT_MAX_TURNS),
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
