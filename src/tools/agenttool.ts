import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '../client'
import { runAgentLoopStream } from '../utils/runagent'
import { ToolRegistrar } from './toolregistrar'
import { Tool } from './tool'

export class AgentTool extends Tool {

  get name(): string {
    return 'agent'
  }

  get description(): string {
    return 'Spawn a sub-agent to handle a self-contained task. The sub-agent has access to read_file, write_file, list_dir, and bash tools. Use this when a task can be fully delegated and its result summarized back.'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task description for the sub-agent to complete' },
        system: { type: 'string', description: 'Optional system prompt override for the sub-agent' },
      },
      required: ['task'],
    }
  }

  async execute(args: any): Promise<string> {
    const task: string = args.task
    const systemOverride: string | undefined = args.system

    const client = createClient()

    const subRegistrar = new ToolRegistrar()
    subRegistrar.registerTool(new (await import('./readtool')).ReadTool())
    subRegistrar.registerTool(new (await import('./writetool')).WriteTool())
    subRegistrar.registerTool(new (await import('./listdirtool')).ListDirTool())
    subRegistrar.registerTool(new (await import('./bashtool')).BashTool())

    const system = systemOverride ?? 'You are a helpful sub-agent. Complete the given task using the tools available to you.'

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: task },
    ]

    const executeTool = async (name: string, input: unknown): Promise<string> => {
      try {
        return await (subRegistrar.getTool(name)?.execute(input as Record<string, string>) ?? Promise.resolve('Unknown tool'))
      } catch (err) {
        return `Error: ${err}`
      }
    }

    process.stdout.write('[sub-agent] ')
    let atLineStart = false
    await runAgentLoopStream({
      client,
      model: 'claude-sonnet-4-6',
      system,
      tools: subRegistrar.getAllTools(),
      messages,
      maxTurns: 20,
      executeTool,
      onText: delta => {
        // Re-prefix after each newline so every output line is tagged
        const prefixed = delta.replace(/\n(?!$)/g, '\n[sub-agent] ')
        process.stdout.write(prefixed)
        atLineStart = delta.endsWith('\n')
      },
    })
    if (!atLineStart) process.stdout.write('\n')

    // Extract the last assistant text as the result
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== 'assistant') continue
      const content = msg.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        const text = content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('')
        if (text) return text
      }
    }

    return '(sub-agent completed with no text output)'
  }
}
