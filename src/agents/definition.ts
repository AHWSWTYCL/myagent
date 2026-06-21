import Anthropic from '@anthropic-ai/sdk'
import { Tool } from '../tools/tool.js'
import { ToolRegistrar } from '../tools/toolregistrar.js'
import type { TranscriptRecorder } from '../utils/transcript.js'

export interface AgentRunContext {
  /** 调用方 agent 名（"main" 表示主 agent；其他值表示 agent 调 agent） */
  source: string
  /** 主 agent 的 toolRegistrar，用于按 name 拿到工具实例 */
  toolRegistrar: ToolRegistrar
  /** 共享的 tool 执行入口（已带 hooks / 权限） */
  executeTool: (name: string, input: unknown) => Promise<string>
  client: Anthropic
  /** Advisor agent 专用的 Claude 原生 client（非 DeepSeek 兼容端点）。agent runner 中对 advisor 自动切换。 */
  advisorClient?: Anthropic
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
  /** 子 agent 开始执行时回调。TUI 据此在任务面板创建一行。 */
  onSubAgentStart?: (name: string, description: string, agentType: string) => void
  /** 子 agent 进度更新。TUI 据此更新任务面板中的工具/Token 计数和当前活动。 */
  onSubAgentProgress?: (name: string, toolUseCount: number, tokenCount: number, lastActivity?: string) => void
  /** 可选的 AbortSignal，用于取消正在运行的 sub-agent */
  signal?: AbortSignal
  /**
   * 该 agent 专属的 TranscriptRecorder（独立 session）。
   * 不设则使用主 recorder（同步 sub-agent 场景），设为独立实例即每个 agent 一个 transcript。
   */
  transcriptRecorder?: TranscriptRecorder
  /** 用于 transcript 的 agentId（不设则 fallback 到 def.name） */
  agentId?: string
  /** 用于 transcript 的 parentAgentId（不设则 fallback 到 ctx.source） */
  parentAgentId?: string
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
  /** Agent 分类标签，用于 TUI 面板中的颜色标记（如 "explore", "general-purpose"）。 */
  agentType?: string
  /** Agent 自己的 system prompt；可以是字符串或异步求值（支持运行时拼接） */
  systemPrompt: string | ((args: Record<string, unknown>, ctx: AgentRunContext) => string | Promise<string>)
  /** 允许使用的全局工具名列表（从 toolRegistrar 取） */
  tools: string[]
  /** 使用的模型名。支持静态字符串或动态函数（如 advisor 运行时切换模型） */
  model?: string | (() => string)
  maxTurns?: number
  /**
   * LLM 输出的最大 token 数（max_tokens）。
   * 不同 agent 的输出量差异很大：analyst 产出完整需求文档可能需要 16000+，
   * verifier 只需输出 APPROVED/NEEDS_REVISION 用 4096 就够。
   * 默认 8192，兼顾大多数场景。
   */
  maxOutputTokens?: number
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

/** 默认 maxOutputTokens：8192，兼顾输出质量和上下文占用 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192

export const DEFAULT_AGENT_INPUT_SCHEMA: AgentInputSchema = {
  properties: {
    task: { type: 'string', description: 'The task description for the sub-agent' },
  },
  required: ['task'],
}
