import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '../client'
import { runAgentLoopStream } from '../utils/runagent'
import { extractLastText, makePrefixedOnText } from '../utils/agentutils'
import { ToolRegistrar } from './toolregistrar'
import { Tool } from './tool'

const MAX_ITERATIONS = 3

const PLANNER_SYSTEM = `你是一个软件架构师。
你可以使用工具读取代码库、列出目录、执行查询命令，充分调研现有代码结构后，再输出一份清晰的分步执行计划。
计划要具体可执行，不要自己动手实现，只输出计划文本。
如果有 verifier 的反馈，请针对反馈修订计划。`

const GENERATOR_SYSTEM = `你是一个资深开发者。
严格按照给定的计划，使用工具完成任务（读写文件、执行命令等）。
如果提供了上一轮的实现摘要和 verifier 反馈，请在此基础上修复问题，而不是从头重写。
完成后输出一份简洁的结果摘要，说明做了什么、结果如何。`

const VERIFIER_SYSTEM = `你是一个代码审查专家和测试工程师。
你可以使用工具读取代码文件、列出目录、运行测试或检查命令，来验证 generator 的实现是否满足原始任务要求。
注意：你只能读取和运行，不能修改任何文件。
如果满足，只回复：APPROVED
如果不满足，回复：NEEDS_REVISION
然后另起一行写出具体的改进意见，说明哪里不对、应该怎么改。`

export class PlannerAgentTool extends Tool {

  get name(): string {
    return 'planner_agent'
  }

  get description(): string {
    return 'Use a planner-generator-verifier pipeline to complete complex tasks. ' +
      'Planner researches the codebase and creates a step-by-step plan, Generator executes it with tools, ' +
      'Verifier reads the actual code to review and test, then feeds back to Planner for up to 3 iterations.'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to complete using the planner-generator-verifier pipeline' },
      },
      required: ['task'],
    }
  }

  async execute(args: any): Promise<string> {
    const task: string = args.task
    const client = createClient()

    const ReadTool = (await import('./readtool')).ReadTool
    const WriteTool = (await import('./writetool')).WriteTool
    const ListDirTool = (await import('./listdirtool')).ListDirTool
    const BashTool = (await import('./bashtool')).BashTool

    // Planner: read-only tools for codebase research
    const plannerRegistrar = new ToolRegistrar()
    plannerRegistrar.registerTool(new ReadTool())
    plannerRegistrar.registerTool(new ListDirTool())
    plannerRegistrar.registerTool(new BashTool())

    const plannerExecuteTool = async (name: string, input: unknown): Promise<string> => {
      try {
        return await (plannerRegistrar.getTool(name)?.execute(input as Record<string, string>) ?? Promise.resolve('Unknown tool'))
      } catch (err) {
        return `Error: ${err}`
      }
    }

    // Generator: full access (read + write + bash)
    const genRegistrar = new ToolRegistrar()
    genRegistrar.registerTool(new ReadTool())
    genRegistrar.registerTool(new WriteTool())
    genRegistrar.registerTool(new ListDirTool())
    genRegistrar.registerTool(new BashTool())

    const genExecuteTool = async (name: string, input: unknown): Promise<string> => {
      try {
        return await (genRegistrar.getTool(name)?.execute(input as Record<string, string>) ?? Promise.resolve('Unknown tool'))
      } catch (err) {
        return `Error: ${err}`
      }
    }

    // Verifier: read + bash for reviewing and testing, no write
    const verRegistrar = new ToolRegistrar()
    verRegistrar.registerTool(new ReadTool())
    verRegistrar.registerTool(new ListDirTool())
    verRegistrar.registerTool(new BashTool())

    const verExecuteTool = async (name: string, input: unknown): Promise<string> => {
      try {
        return await (verRegistrar.getTool(name)?.execute(input as Record<string, string>) ?? Promise.resolve('Unknown tool'))
      } catch (err) {
        return `Error: ${err}`
      }
    }

    let feedback = ''
    let result = ''
    let previousResult = ''

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const iteration = i + 1
      console.log(`\n[pipeline] 第 ${iteration} 轮`)

      // 1. Planner — researches codebase then outputs a plan
      const plannerInput = feedback
        ? `任务：${task}\n\nVerifier 的反馈（请根据此修订计划）：\n${feedback}`
        : `任务：${task}`

      const planMessages: Anthropic.MessageParam[] = [
        { role: 'user', content: plannerInput },
      ]
      await runAgentLoopStream({
        client,
        model: 'claude-sonnet-4-6',
        system: PLANNER_SYSTEM,
        tools: plannerRegistrar.getAllTools(),
        messages: planMessages,
        maxTurns: 10,
        executeTool: plannerExecuteTool,
        onText: makePrefixedOnText('[planner]'),
      })
      process.stdout.write('\n')
      const plan = extractLastText(planMessages)

      // 2. Generator — on revision rounds, include previous result and verifier feedback
      let genUserContent = `任务：${task}\n\n执行计划：\n${plan}`
      if (i > 0 && previousResult && feedback) {
        genUserContent +=
          `\n\n上一轮的实现摘要：\n${previousResult}` +
          `\n\nVerifier 的反馈（需要修复的问题）：\n${feedback}`
      }

      const genMessages: Anthropic.MessageParam[] = [
        { role: 'user', content: genUserContent },
      ]
      await runAgentLoopStream({
        client,
        model: 'claude-sonnet-4-6',
        system: GENERATOR_SYSTEM,
        tools: genRegistrar.getAllTools(),
        messages: genMessages,
        maxTurns: 20,
        executeTool: genExecuteTool,
        onText: makePrefixedOnText('[generator]'),
      })
      process.stdout.write('\n')
      result = extractLastText(genMessages)
      previousResult = result

      // 3. Verifier — reads actual files to review and test
      const verMessages: Anthropic.MessageParam[] = [
        {
          role: 'user',
          content:
            `原始任务：${task}\n\n执行计划：\n${plan}\n\nGenerator 的结果摘要：\n${result}\n\n` +
            `请使用工具读取相关文件，验证实现是否正确，必要时运行测试命令。`,
        },
      ]
      await runAgentLoopStream({
        client,
        model: 'claude-sonnet-4-6',
        system: VERIFIER_SYSTEM,
        tools: verRegistrar.getAllTools(),
        messages: verMessages,
        maxTurns: 10,
        executeTool: verExecuteTool,
        onText: makePrefixedOnText('[verifier]'),
      })
      process.stdout.write('\n')
      const review = extractLastText(verMessages)

      if (review.trimStart().startsWith('APPROVED')) {
        console.log('[pipeline] Verifier 通过，任务完成。')
        break
      }

      feedback = review.replace(/^NEEDS_REVISION\s*/i, '').trim()
      if (i === MAX_ITERATIONS - 1) {
        console.log('[pipeline] 已达最大迭代轮数，返回当前结果。')
      }
    }

    return result
  }
}
