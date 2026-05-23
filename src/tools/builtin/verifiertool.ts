import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '../../client'
import { runAgentLoopStream } from '../../utils/runagent'
import { extractLastText, makePrefixedOnText } from '../../utils/agentutils'
import { ToolRegistrar } from '../toolregistrar'
import { Tool } from '../tool'
import { TaskManager } from '../../tasks/taskmanager'

const VERIFIER_SYSTEM = `你是一个代码审查专家和测试工程师。
你会被给出：原始目标（root task 描述了完整需求文档与验收标准）、当前子任务、generator 的实现摘要。
使用工具读取实际文件、运行测试或检查命令，验证 generator 的实现是否满足该子任务，且没有破坏 root task 的整体目标和约束。
你只能读取和运行，不能修改文件。

输出格式严格遵守：
第一行只能是 APPROVED 或 NEEDS_REVISION，不能有任何其他字符。
如果 NEEDS_REVISION，从第二行开始写具体的、可执行的改进意见（哪个文件、哪段代码、应该改成什么）。`

export class VerifierTool extends Tool {

  get name(): string {
    return 'verifier'
  }

  get description(): string {
    return 'Review whether a generator\'s output satisfies a subtask without breaking the root goal. ' +
      'Preferred usage: pass task_id (+ optional root_task_id) and result; the tool loads descriptions from the kanban. ' +
      'Legacy usage: pass task + result strings inline. ' +
      'Returns APPROVED or NEEDS_REVISION (first line) followed by feedback.'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Kanban id of the subtask being verified. Preferred.' },
        root_task_id: { type: 'string', description: 'Kanban id of the root task that holds the overall goal. Optional.' },
        result: { type: 'string', description: 'Generator\'s result summary' },
        task: { type: 'string', description: 'Legacy: original task description (used only when task_id is absent)' },
        plan: { type: 'string', description: 'Legacy: plan that was executed' },
      },
      required: ['result'],
    }
  }

  async execute(args: any): Promise<string> {
    const result: string = args.result
    if (!result) return 'Error: result is required'

    const taskId: string = args.task_id ?? ''
    const rootTaskId: string = args.root_task_id ?? ''
    let userContent: string

    if (taskId) {
      const tm = new TaskManager()
      const task = tm.get(taskId)
      if (!task) return `Error: task ${taskId} not found`
      const rootGoal = rootTaskId
        ? (tm.get(rootTaskId)?.description ?? '(root task not found)')
        : '(未提供 root_task_id，仅基于子任务验收标准评估)'
      userContent =
        `Root 目标 / 整体需求文档:\n${rootGoal}\n\n` +
        `当前子任务 (${task.id}) ${task.title}\n${task.description}\n\n` +
        `Generator 摘要:\n${result}\n\n` +
        `请使用工具实地验证，第一行只输出 APPROVED 或 NEEDS_REVISION。`
    } else {
      const taskDesc: string = args.task ?? ''
      const plan: string = args.plan ?? ''
      if (!taskDesc) return 'Error: must provide task_id, or legacy task field'
      const base = plan
        ? `原始任务：${taskDesc}\n\n执行计划：\n${plan}\n\nGenerator 的结果摘要：\n${result}`
        : `原始任务：${taskDesc}\n\nGenerator 的结果摘要：\n${result}`
      userContent = base + '\n\n请使用工具读取相关文件，验证实现是否正确，第一行只输出 APPROVED 或 NEEDS_REVISION。'
    }

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

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }]

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
