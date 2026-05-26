import Anthropic from '@anthropic-ai/sdk'
import { Tool } from './tool.js'
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

  constructor(
    private registry: AgentRegistry,
    private toolRegistrar: ToolRegistrar,
  ) { super() }

  setExecutionContext(opts: {
    client: Anthropic
    executeTool: (name: string, input: unknown) => Promise<string>
    emitLine: (line: string) => void
    onSubAgentDelta?: (name: string, delta: string) => void
  }) {
    this.client = opts.client
    this.executeToolFn = opts.executeTool
    this.emitLineFn = opts.emitLine
    this.onSubAgentDeltaFn = opts.onSubAgentDelta
  }

  get name(): string { return 'agent' }

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

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    // 取所有 agent input schema 的并集，agent / task / source 是固定字段
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

    try {
      return await runAgent(def, args, {
        source: args.source ?? 'main',
        toolRegistrar: this.toolRegistrar,
        executeTool: this.executeToolFn,
        client: this.client,
        emitLine: this.emitLineFn,
        onSubAgentDelta: this.onSubAgentDeltaFn,
      })
    } catch (err) {
      return `Error running agent "${args.agent}": ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
