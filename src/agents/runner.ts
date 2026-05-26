import Anthropic from '@anthropic-ai/sdk'
import { runAgentLoopStream } from '../utils/runagent.js'
import { ToolRegistrar } from '../tools/toolregistrar.js'
import { Tool } from '../tools/tool.js'
import { extractLastText, makePrefixedEmit } from '../utils/agentutils.js'
import { AgentDefinition, AgentRunContext } from './definition.js'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
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

  const subExecuteTool = async (name: string, input: unknown): Promise<string> => {
    // Agent-only 工厂工具优先（不会出现在主 toolRegistrar 中），直接走自己的 execute
    const local = extras.find(t => t.name === name)
    if (local) {
      try { return await local.execute(input as Record<string, string>) }
      catch (err) { return `Error: ${err}` }
    }
    // 全局工具走主流程，这样 hooks / 权限继续生效
    return ctx.executeTool(name, input)
  }

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

  // ── 4. 跑循环 ────────────────────────────────────────────────────────
  const prefix = `[${def.name}]`
  const prefixedEmit = makePrefixedEmit(prefix, ctx.emitLine)
  const onText = (delta: string) => {
    // 实时流：TUI 侧直接渲染增量（无前缀，由 TUI 面板负责标识）
    ctx.onSubAgentDelta?.(def.name, delta)
    // 持久记录：按行缓冲后走 emitLine（带 [agent-name] 前缀）
    prefixedEmit(delta)
  }
  ctx.emitLine(`${prefix} ← invoked by ${ctx.source}`)

  await runAgentLoopStream({
    client: ctx.client,
    model: def.model ?? DEFAULT_MODEL,
    system,
    tools: subRegistrar.getAllTools(),
    messages,
    maxTurns: def.maxTurns ?? DEFAULT_MAX_TURNS,
    executeTool: subExecuteTool,
    parallelSafeTools: subRegistrar.getParallelSafeNames(),
    onText,
  })

  const lastText = extractLastText(messages)
  if (def.finalize) return def.finalize(messages, lastText, ctx, args)
  return lastText || `(agent "${def.name}" produced no text output)`
}
