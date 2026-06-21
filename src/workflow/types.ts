// Workflow 编排系统 — 类型定义

import type { AgentRunContext } from '../agents/definition.js'

export type { AgentRunContext }

export interface AgentOpts {
  /** 进度树中显示的标签，默认截取 prompt 前 40 字 */
  label?: string
  /** 归属哪个 phase 进度分组 */
  phase?: string
  /** 强制结构化输出的 JSON Schema，agent() 返回验证后的对象而非字符串 */
  schema?: Record<string, unknown>
  /** 覆盖模型，默认继承 runtime 配置 */
  model?: string
  /** 在隔离 git worktree 中运行（并行写文件时防冲突） */
  isolation?: 'worktree'
  /** 该子 agent 可使用的工具名列表（从 ctx.toolRegistrar 取） */
  tools?: string[]
}

export interface WorkflowMeta {
  name: string
  description: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
  whenToUse?: string
}

export interface WorkflowBudget {
  /** 用户通过 "+NNNk" 指令设置的 token 上限，null 表示未设置 */
  total: number | null
  /** 返回当前已消耗的 output tokens */
  spent(): number
  /** 返回剩余预算，未设置时返回 Infinity */
  remaining(): number
}

export interface WorkflowRunOptions {
  /** 脚本字符串 */
  script?: string
  /** 脚本文件路径（优先于 script，也用于 registry 记录） */
  scriptPath?: string
  /** 传给脚本的 args 全局变量 */
  args?: unknown
  /** 恢复上次运行，命中缓存的 agent() 直接返回 */
  resumeFromRunId?: string
  /** Token 预算上限（output tokens） */
  tokenBudget?: number
  /** 每个 agent 调用使用的默认模型 */
  model?: string
  /** journal 文件存放目录，默认 ~/.myagent/workflow-journals/ */
  journalDir?: string
  /** 预指定 runId（不传则自动生成）。WorkflowTool 用于在执行前先保存脚本 */
  runId?: string
  /** myagent 运行上下文，提供 client、工具注册表、emitLine 等基础设施 */
  ctx: AgentRunContext
}

export interface WorkflowRunResult {
  runId: string
  /** 脚本最终返回值 */
  returnValue: unknown
  /** 总消耗 output tokens */
  outputTokens: number
}
