import { AgentDefinition } from '../definition.js'
import { TaskManager } from '../../tasks/taskmanager.js'

const SYSTEM = `你是一个代码审查专家和测试工程师。
你会被给出：原始目标（root task 描述了完整需求文档与验收标准）、当前子任务、generator 的实现摘要。
使用工具读取实际文件、运行测试或检查命令，验证 generator 的实现是否满足该子任务，且没有破坏 root task 的整体目标和约束。
你只能读取和运行，不能修改文件。

输出格式严格遵守：
第一行只能是 APPROVED 或 NEEDS_REVISION，不能有任何其他字符。
如果 NEEDS_REVISION，从第二行开始写具体的、可执行的改进意见（哪个文件、哪段代码、应该改成什么）。

## Guidelines

1. **工具调用纪律**: 每次工具调用完成后，等待并读取返回结果再做下一步。不要假设或猜测结果内容。
2. **错误处理**: 工具调用返回错误时，先诊断原因再决定下一步，不要静默忽略。非致命错误应在最终报告中注明。
3. **输出完整性**: 最终输出必须包含执行总结，让调用方能直接理解你做了什么、结果如何、有什么需要注意的事项。
4. **边界意识**: 只使用分配给你的工具集完成职责范围内的工作。不要越权访问其他 agent 的工具，不要修改未授权的文件。`

export const verifierAgent: AgentDefinition = {
  name: 'verifier',
  description:
    'Review whether a generator output satisfies a subtask without breaking the root goal. ' +
    'Preferred usage: pass task_id (+ optional root_task_id) and result; the agent loads descriptions from the kanban. ' +
    'Returns APPROVED or NEEDS_REVISION (first line) followed by feedback.',
  systemPrompt: SYSTEM,
  tools: ['read_file', 'list_dir', 'bash'],
  maxTurns: 10,
  inputSchema: {
    properties: {
      task_id: { type: 'string', description: 'Kanban id of the subtask being verified. Preferred.' },
      root_task_id: { type: 'string', description: 'Kanban id of the root task that holds the overall goal.' },
      result: { type: 'string', description: 'Generator result summary' },
      task: { type: 'string', description: 'Legacy: original task description' },
      plan: { type: 'string', description: 'Legacy: plan that was executed' },
    },
    required: ['result'],
  },
  formatUserMessage: args => {
    const result = (args.result as string) ?? ''
    if (!result) return 'Error: result is required'
    const taskId = (args.task_id as string) ?? ''
    const rootTaskId = (args.root_task_id as string) ?? ''

    if (taskId) {
      const tm = new TaskManager()
      const task = tm.get(taskId)
      if (!task) return `Error: task ${taskId} not found`
      const rootGoal = rootTaskId
        ? (tm.get(rootTaskId)?.description ?? '(root task not found)')
        : '(未提供 root_task_id，仅基于子任务验收标准评估)'
      return (
        `Root 目标 / 整体需求文档:\n${rootGoal}\n\n` +
        `当前子任务 (${task.id}) ${task.title}\n${task.description}\n\n` +
        `Generator 摘要:\n${result}\n\n` +
        `请使用工具实地验证，第一行只输出 APPROVED 或 NEEDS_REVISION。`
      )
    }
    const taskDesc = (args.task as string) ?? ''
    const plan = (args.plan as string) ?? ''
    if (!taskDesc) return 'Error: must provide task_id, or legacy task field'
    const base = plan
      ? `原始任务：${taskDesc}\n\n执行计划：\n${plan}\n\nGenerator 的结果摘要：\n${result}`
      : `原始任务：${taskDesc}\n\nGenerator 的结果摘要：\n${result}`
    return base + '\n\n请使用工具读取相关文件，验证实现是否正确，第一行只输出 APPROVED 或 NEEDS_REVISION。'
  },
}
