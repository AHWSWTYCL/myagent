import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '../../client'
import { runAgentLoopStream } from '../../utils/runagent'
import { extractLastText, makePrefixedOnText } from '../../utils/agentutils'
import { ToolRegistrar } from '../toolregistrar'
import { Tool } from '../tool'

const VERIFIER_SYSTEM = `你是一个代码审查专家和测试工程师。
你可以使用工具读取代码文件、列出目录、运行测试或检查命令，来验证 generator 的实现是否满足原始任务要求。
注意：你只能读取和运行，不能修改任何文件。
如果满足，只回复：APPROVED
如果不满足，回复：NEEDS_REVISION
然后另起一行写出具体的改进意见，说明哪里不对、应该怎么改。`

export class VerifierTool extends Tool {

  get name(): string {
    return 'verifier'
  }

  get description(): string {
    return 'Review whether a generator\'s result satisfies the original task by reading actual files and running tests. Returns APPROVED or NEEDS_REVISION with specific feedback.'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The original task description' },
        plan: { type: 'string', description: 'The plan that was executed' },
        result: { type: 'string', description: 'The result summary from the generator' },
      },
      required: ['task', 'result'],
    }
  }

  async execute(args: any): Promise<string> {
    const task: string = args.task
    const plan: string = args.plan ?? ''
    const result: string = args.result
    const client = createClient()

    const registrar = new ToolRegistrar()
    registrar.registerTool(new (await import('../readtool')).ReadTool())
    registrar.registerTool(new (await import('../listdirtool')).ListDirTool())
    registrar.registerTool(new (await import('../bashtool')).BashTool())

    const executeTool = async (name: string, input: unknown): Promise<string> => {
      try {
        return await (registrar.getTool(name)?.execute(input as Record<string, string>) ?? Promise.resolve('Unknown tool'))
      } catch (err) {
        return `Error: ${err}`
      }
    }

    const baseContent = plan
      ? `原始任务：${task}\n\n执行计划：\n${plan}\n\nGenerator 的结果摘要：\n${result}`
      : `原始任务：${task}\n\nGenerator 的结果摘要：\n${result}`

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: baseContent + '\n\n请使用工具读取相关文件，验证实现是否正确，必要时运行测试命令。' },
    ]

    await runAgentLoopStream({
      client,
      model: 'claude-sonnet-4-6',
      system: VERIFIER_SYSTEM,
      tools: registrar.getAllTools(),
      messages,
      maxTurns: 10,
      executeTool,
      onText: makePrefixedOnText('[verifier]'),
    })
    process.stdout.write('\n')

    return extractLastText(messages)
  }
}
