import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '../client'
import { runAgentLoopStream } from '../utils/runagent'
import { extractLastText, makePrefixedOnText } from '../utils/agentutils'
import { ToolRegistrar } from './toolregistrar'
import { Tool } from './tool'

const GENERATOR_SYSTEM = `你是一个资深开发者。
严格按照给定的计划，使用工具完成任务（读写文件、执行命令等）。
如果提供了上一轮的实现摘要和 verifier 反馈，请在此基础上修复问题，而不是从头重写。
完成后输出一份简洁的结果摘要，说明做了什么、结果如何。`

export class GeneratorTool extends Tool {

  get name(): string {
    return 'generator'
  }

  get description(): string {
    return 'Execute a task according to a given plan using file and bash tools. Returns a result summary.'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The original task description' },
        plan: { type: 'string', description: 'The step-by-step plan to execute' },
        previousResult: { type: 'string', description: 'Optional: result summary from the previous iteration' },
        feedback: { type: 'string', description: 'Optional: verifier feedback from the previous iteration to address' },
      },
      required: ['task', 'plan'],
    }
  }

  async execute(args: any): Promise<string> {
    const task: string = args.task
    const plan: string = args.plan
    const previousResult: string = args.previousResult ?? ''
    const feedback: string = args.feedback ?? ''
    const client = createClient()

    const registrar = new ToolRegistrar()
    registrar.registerTool(new (await import('./readtool')).ReadTool())
    registrar.registerTool(new (await import('./writetool')).WriteTool())
    registrar.registerTool(new (await import('./listdirtool')).ListDirTool())
    registrar.registerTool(new (await import('./bashtool')).BashTool())

    const executeTool = async (name: string, input: unknown): Promise<string> => {
      try {
        return await (registrar.getTool(name)?.execute(input as Record<string, string>) ?? Promise.resolve('Unknown tool'))
      } catch (err) {
        return `Error: ${err}`
      }
    }

    let userContent = `任务：${task}\n\n执行计划：\n${plan}`
    if (previousResult && feedback) {
      userContent +=
        `\n\n上一轮的实现摘要：\n${previousResult}` +
        `\n\nVerifier 的反馈（需要修复的问题）：\n${feedback}`
    }

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userContent },
    ]

    await runAgentLoopStream({
      client,
      model: 'claude-sonnet-4-6',
      system: GENERATOR_SYSTEM,
      tools: registrar.getAllTools(),
      messages,
      maxTurns: 20,
      executeTool,
      onText: makePrefixedOnText('[generator]'),
    })
    process.stdout.write('\n')

    return extractLastText(messages)
  }
}
