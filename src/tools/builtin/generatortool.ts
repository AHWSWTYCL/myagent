import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '../../client'
import { runAgentLoopStream } from '../../utils/runagent'
import { extractLastText, makePrefixedOnText } from '../../utils/agentutils'
import { ToolRegistrar } from '../toolregistrar'
import { Tool } from '../tool'
import { TaskManager } from '../../tasks/taskmanager'

const GENERATOR_SYSTEM = `你是一个资深开发者。
你会被分配一个具体的子任务，其 description 已经被 planner 写成自包含的执行说明——里面包含涉及文件、要做的改动、接口契约、约束和验收标准。
**仅依赖 description 工作**：不要试图查询 planner 的意图，不要假设有更多上下文，所需信息都在 description 中。如果觉得 description 缺少关键信息，先用 read_file / list_dir / bash 自行确认现状再动手，而不是猜测。
使用工具完成任务（read_file / write_file / list_dir / bash）。
如果 description 末尾有 "## Review Feedback" 段落，说明上一次提交被 verifier 打回了，请基于反馈定点修复，而不是从头重写。
完成后输出一段简洁的文字说明你做了什么、改了哪些文件、结果如何。不要修改任务状态，coordinator 会处理。`

export class GeneratorTool extends Tool {

  get name(): string {
    return 'generator'
  }

  get description(): string {
    return 'Execute a planned subtask. Preferred usage: pass task_id and the tool will load the self-contained description from the kanban. ' +
      'Legacy usage: pass task + plan strings inline. Returns a result summary.'
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Kanban task id created by planner_agent. Preferred.' },
        task: { type: 'string', description: 'Legacy: original task description (used only when task_id is absent)' },
        plan: { type: 'string', description: 'Legacy: step-by-step plan (used only when task_id is absent)' },
      },
      required: [],
    }
  }

  async execute(args: any): Promise<string> {
    const taskId: string = args.task_id ?? ''
    let userContent: string

    if (taskId) {
      const tm = new TaskManager()
      const task = tm.get(taskId)
      if (!task) return `Error: task ${taskId} not found`
      userContent =
        `任务 ID: ${task.id}\n` +
        `标题: ${task.title}\n\n` +
        `描述（含执行上下文，可能带 Review Feedback）:\n${task.description}`
    } else {
      const taskDesc: string = args.task ?? ''
      const plan: string = args.plan ?? ''
      if (!taskDesc) return 'Error: must provide task_id, or legacy task field'
      userContent = plan
        ? `任务：${taskDesc}\n\n执行计划：\n${plan}`
        : `任务：${taskDesc}`
    }

    const client = createClient()
    const registrar = new ToolRegistrar()
    registrar.registerTool(new (await import('../readtool')).ReadTool())
    registrar.registerTool(new (await import('../writetool')).WriteTool())
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
