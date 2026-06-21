import { AgentDefinition } from '../definition.js'
import { TaskManager } from '../../tasks/taskmanager.js'

const SYSTEM = `你是一个资深开发者。
你会被分配一个具体的子任务，其 description 已经被 planner 写成自包含的执行说明——里面包含涉及文件、要做的改动、接口契约、约束和验收标准。
**仅依赖 description 工作**：不要试图查询 planner 的意图，不要假设有更多上下文，所需信息都在 description 中。如果觉得 description 缺少关键信息，先用 read_file / list_dir / bash 自行确认现状再动手，而不是猜测。
使用工具完成任务（read_file / write_file / list_dir / bash）。
如果 description 末尾有 "## Review Feedback" 段落，说明上一次提交被 verifier 打回了，请基于反馈定点修复，而不是从头重写。
完成后输出一段简洁的文字说明你做了什么、改了哪些文件、结果如何。不要修改任务状态，coordinator 会处理。

## Guidelines

1. **工具调用纪律**: 每次工具调用完成后，等待并读取返回结果再做下一步。不要假设或猜测结果内容。
2. **错误处理**: 工具调用返回错误时，先诊断原因再决定下一步，不要静默忽略。非致命错误应在最终报告中注明。
3. **输出完整性**: 最终输出必须包含执行总结，让调用方能直接理解你做了什么、结果如何、有什么需要注意的事项。
4. **边界意识**: 只使用分配给你的工具集完成职责范围内的工作。不要越权访问其他 agent 的工具，不要修改未授权的文件。`

export const generatorAgent: AgentDefinition = {
  name: 'generator',
  description:
    'Execute a planned subtask. Preferred usage: pass task_id and the agent will load the self-contained description from the kanban. ' +
    'Legacy usage: pass task + plan inline. Returns a result summary.',
  systemPrompt: SYSTEM,
  tools: ['read_file', 'write_file', 'list_dir', 'bash'],
  model: 'deepseek-v4-flash',
  maxTurns: 20,
  maxOutputTokens: 12000, // 代码改动 + 说明
  inputSchema: {
    properties: {
      task_id: { type: 'string', description: 'Kanban task id created by planner. Preferred.' },
      task: { type: 'string', description: 'Legacy: original task description (used only when task_id is absent)' },
      plan: { type: 'string', description: 'Legacy: step-by-step plan (used only when task_id is absent)' },
    },
    required: [],
  },
  formatUserMessage: args => {
    const taskId = (args.task_id as string) ?? ''
    if (taskId) {
      const tm = new TaskManager()
      const task = tm.get(taskId)
      if (!task) return `Error: task ${taskId} not found`
      return `任务 ID: ${task.id}\n标题: ${task.title}\n\n描述（含执行上下文，可能带 Review Feedback）:\n${task.description}`
    }
    const taskDesc = (args.task as string) ?? ''
    const plan = (args.plan as string) ?? ''
    if (!taskDesc) return 'Error: must provide task_id, or legacy task field'
    return plan ? `任务：${taskDesc}\n\n执行计划：\n${plan}` : `任务：${taskDesc}`
  },
}
