import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { ToolRegistrar } from './toolregistrar.js'
import { AgentRegistry } from '../agents/registry.js'
import { runAgent } from '../agents/runner.js'

interface AgentToolInput {
  agent: string
  source?: string
  task?: string
  [key: string]: unknown
}

/**
 * 唯一的 agent 调度入口。
 *
 * 主 LLM（或某个 sub-agent）通过它选择并启动一个 sub-agent；
 * 具体可调用的 agent 列表由注册到 AgentRegistry 中的定义决定。
 *
 * 通过 setExecutionContext 由 agent.ts 注入 client / executeTool / emitLine —
 * 这些不能在构造时拿到（循环依赖）。
 */
export class AgentTool extends Tool {
  private client?: Anthropic
  private executeToolFn?: (name: string, input: unknown) => Promise<string>
  private emitLineFn?: (line: string) => void
  private onSubAgentDeltaFn?: (name: string, delta: string) => void
  private onSubAgentHeartbeatFn?: (name: string, elapsedMs: number) => void
  private onSubAgentStartFn?: (name: string, description: string, agentType: string) => void
  private onSubAgentProgressFn?: (name: string, toolUseCount: number, tokenCount: number, lastActivity?: string) => void
  private onSubAgentDoneFn?: (name: string, status: 'completed' | 'failed' | 'killed', error?: string) => void
  private currentSignal?: AbortSignal

  constructor(
    private registry: AgentRegistry,
    private toolRegistrar: ToolRegistrar,
  ) { super() }

  setExecutionContext(opts: {
    client: Anthropic
    executeTool: (name: string, input: unknown) => Promise<string>
    emitLine: (line: string) => void
    onSubAgentDelta?: (name: string, delta: string) => void
    onSubAgentHeartbeat?: (name: string, elapsedMs: number) => void
    onSubAgentStart?: (name: string, description: string, agentType: string) => void
    onSubAgentProgress?: (name: string, toolUseCount: number, tokenCount: number, lastActivity?: string) => void
    onSubAgentDone?: (name: string, status: 'completed' | 'failed' | 'killed', error?: string) => void
  }) {
    this.client = opts.client
    this.executeToolFn = opts.executeTool
    this.emitLineFn = opts.emitLine
    this.onSubAgentDeltaFn = opts.onSubAgentDelta
    this.onSubAgentHeartbeatFn = opts.onSubAgentHeartbeat
    this.onSubAgentStartFn = opts.onSubAgentStart
    this.onSubAgentProgressFn = opts.onSubAgentProgress
    this.onSubAgentDoneFn = opts.onSubAgentDone
  }

  /** 设置当前 turn 的 AbortSignal，传递给 sub-agent 内部循环以实现 Esc 取消。 */
  setSignal(signal?: AbortSignal) {
    this.currentSignal = signal
  }

  get name(): string { return 'agent' }

  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const agentName = String(input.agent ?? 'sub-agent')
    const task = String(input.task ?? '')
    return { label: `Task(${agentName})`, args: task ? Tool.truncate(task, 100) : '' }
  }

  renderToolResult(output: string, isError: boolean): string[] {
    return Tool.summarize(output, isError)
  }

  get description(): string {
    const lines = [
      'Spawn a sub-agent to handle a self-contained task.',
      'Pick `agent` from the registered list. Each agent has its own description, allowed tools and input schema; the union of input fields is exposed below — pass only what the chosen agent expects.',
      '',
      'Available agents:',
    ]
    for (const a of this.registry.list()) {
      lines.push(`- **${a.name}** — ${a.description.replace(/\s+/g, ' ').trim()}`)
    }
    return lines.join('\n')
  }

  get inputSchemaZod() {
    const names = this.registry.list().map(a => a.name)
    // Names is built at runtime; if no agents registered yet, fall back to z.string()
    // so validation isn't impossible. enum() requires non-empty.
    const agentName = names.length > 0 ? z.enum(names as [string, ...string[]]) : z.string()
    return z.object({
      agent: agentName,
      task: z.string().optional(),
      source: z.string().optional(),
    }).passthrough()  // sub-agent-specific fields are validated by the agent itself
  }

  get outputSchemaZod() {
    return z.string()
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    const properties: Record<string, unknown> = {
      agent: {
        type: 'string',
        enum: this.registry.list().map(a => a.name),
        description: 'Which sub-agent to spawn.',
      },
      task: {
        type: 'string',
        description: 'High-level task description. Most agents accept this; some accept extra fields (see agent description).',
      },
      source: {
        type: 'string',
        description: 'Caller agent name (e.g. "main", "coordinator"). Optional, used for logging.',
      },
    }
    for (const a of this.registry.list()) {
      if (!a.inputSchema) continue
      for (const [k, v] of Object.entries(a.inputSchema.properties)) {
        if (k in properties) continue
        properties[k] = v
      }
    }
    return {
      type: 'object',
      properties,
      required: ['agent'],
    }
  }

  async execute(args: AgentToolInput): Promise<string> {
    if (!this.client || !this.executeToolFn || !this.emitLineFn) {
      return 'Error: AgentTool is not initialized; setExecutionContext was never called.'
    }
    const def = this.registry.get(args.agent)
    if (!def) {
      const known = this.registry.list().map(a => a.name).join(', ')
      return `Error: unknown agent "${args.agent}". Available: ${known}`
    }

    // Notify TUI panel that a new sub-agent started
    this.onSubAgentStartFn?.(def.name, String(args.task ?? ''), def.agentType ?? 'general-purpose')

    try {
      const result = await runAgent(def, args, {
        source: args.source ?? 'main',
        toolRegistrar: this.toolRegistrar,
        executeTool: this.executeToolFn,
        client: this.client,
        emitLine: this.emitLineFn,
        onSubAgentDelta: this.onSubAgentDeltaFn,
        onSubAgentHeartbeat: this.onSubAgentHeartbeatFn,
        onSubAgentStart: this.onSubAgentStartFn,
        onSubAgentProgress: this.onSubAgentProgressFn,
        signal: this.currentSignal,
      })
      this.onSubAgentDoneFn?.(def.name, 'completed')
      return result
    } catch (err) {
      const msg = `Error running agent "${args.agent}": ${err instanceof Error ? err.message : String(err)}`
      this.onSubAgentDoneFn?.(def.name, 'failed', msg)
      return msg
    }
  }
}
