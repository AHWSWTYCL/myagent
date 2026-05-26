import Anthropic from '@anthropic-ai/sdk'
import { Tool } from '../tools/tool.js'
import { ToolRegistrar } from '../tools/toolregistrar.js'

export interface AgentRunContext {
  /** 调用方 agent 名（"main" 表示主 agent；其他值表示 agent 调 agent） */
  source: string
  /** 主 agent 的 toolRegistrar，用于按 name 拿到工具实例 */
  toolRegistrar: ToolRegistrar
  /** 共享的 tool 执行入口（已带 hooks / 权限） */
  executeTool: (name: string, input: unknown) => Promise<string>
  client: Anthropic
  emitLine: (line: string) => void
  /**
   * 子 agent 实时增量输出的回调。
   * TUI 层会订阅这个 delta 流并实时渲染在 tool spinner 下方。
   * name 是 agent 定义名（如 project_builder），delta 是纯文本增量（无前缀）。
   * 可以不设，设了后 runner.ts 会在 emitLine 之外额外推送。
   */
  onSubAgentDelta?: (name: string, delta: string) => void
  /**
   * 子 agent 内长时间静默的命令的心跳事件。
   * 用于让 TUI 显示一个动画（如 spinner）告诉用户「还活着」，而不是把心跳行
   * 拼进文本面板。elapsedMs 是命令开始到此次心跳的总耗时（毫秒）。
   * 数据一来到（如 stdout/stderr）应该停止发心跳，TUI 据此自动隐藏动画。
   */
  onSubAgentHeartbeat?: (name: string, elapsedMs: number) => void
  /** 可选的 AbortSignal，用于取消正在运行的 sub-agent */
  signal?: AbortSignal
}

/** Agent 接收的参数 schema 暴露给主 LLM */
export interface AgentInputSchema {
  properties: Record<string, unknown>
  required?: string[]
}

export interface AgentDefinition {
  name: string
  /** 描述给主 LLM 看：什么时候用这个 agent。要写得能让 LLM 自主选择。 */
  description: string
  /** Agent 自己的 system prompt；可以是字符串或异步求值（支持运行时拼接） */
  systemPrompt: string | ((args: Record<string, unknown>, ctx: AgentRunContext) => string | Promise<string>)
  /** 允许使用的全局工具名列表（从 toolRegistrar 取） */
  tools: string[]
  model?: string
  maxTurns?: number
  /** 默认 schema：{ task: string }。Agent 需要更复杂入参时可以覆盖 */
  inputSchema?: AgentInputSchema
  /** 把入参拼成 user message。默认：直接用 args.task */
  formatUserMessage?: (args: Record<string, unknown>, ctx: AgentRunContext) => string | Promise<string>
  /** 仅在该 agent 运行期内可用的工厂工具（带闭包状态）。每次 runAgent 都会新建一份。 */
  extraTools?: (ctx: AgentRunContext, args: Record<string, unknown>) => Tool[] | Promise<Tool[]>
  /** 跑完之后的钩子（可读 messages、createdIds 之类的状态） */
  finalize?: (
    messages: Anthropic.MessageParam[],
    lastText: string,
    ctx: AgentRunContext,
    args: Record<string, unknown>,
  ) => string | Promise<string>
}

export const DEFAULT_AGENT_INPUT_SCHEMA: AgentInputSchema = {
  properties: {
    task: { type: 'string', description: 'The task description for the sub-agent' },
  },
  required: ['task'],
}
