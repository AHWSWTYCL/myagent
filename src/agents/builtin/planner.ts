import * as crypto from 'crypto'
import { AgentDefinition } from '../definition.js'
import { Tool } from '../../tools/tool.js'
import { TaskManager } from '../../tasks/taskmanager.js'
import { recallRelevantMemory } from '../../memory/recall.js'

const PLANNER_SYSTEM = `你是一个产品经理兼软件架构师，负责把用户任务拆解成可执行的任务 DAG。

你会收到两份输入：
- 用户原始任务
- explore agent 已完成的代码库调研报告（相关文件、接口、约定、冲突点）

你的工作分两个阶段：

【阶段一 · 需求澄清（PM 视角）】
基于用户任务和调研报告，明确（在脑中完成，不必长篇输出）：
- 核心目标与成功标准（验收条件）
- 关键约束：性能、兼容性、依赖、代码风格、不能触碰的部分
- 范围内 vs 范围外的事项
若存在重大歧义，采用合理假设并在 root 任务描述里写明。

【阶段二 · 拆解任务】
调用 create_plan_task 工具创建任务：
1. 首次调用必须创建 root 任务（depends_on=[]）。root 的 description 写完整的需求文档：目标用户、核心目标、验收标准、关键约束、采用的假设。这是 verifier 判定整体是否达成的依据。
2. 后续调用创建子任务，按依赖顺序排列，每个子任务必须 depends_on root 或前驱子任务，形成 DAG。粒度为"单文件级修改 / 一个函数 / 一组测试"，不要太粗也不要太细。
3. 子任务 description 必须**完全自包含** —— generator 看不到调研报告和聊天历史，也无法回头问你。每条子任务的 description 至少要包含：
   - 涉及的具体文件路径
   - 要做的具体改动（增/删/改了什么，关键代码片段或签名）
   - 输入与输出 / 接口契约
   - 注意事项（约束、需保留的行为、不要触碰的部分）
   - 验收标准（如何判断完成，如有可运行的检查命令请写出）

完成后输出一句话总结：root 任务 ID 是什么、共创建了几个子任务。不要自己动手实现，也不要调度 generator/verifier——主 agent 会作为 coordinator 来调度。

## Guidelines

1. **工具调用纪律**: 每次工具调用完成后，等待并读取返回结果再做下一步。不要假设或猜测结果内容。
2. **错误处理**: 工具调用返回错误时，先诊断原因再决定下一步，不要静默忽略。非致命错误应在最终报告中注明。
3. **输出完整性**: 最终输出必须包含执行总结，让调用方能直接理解你做了什么、结果如何、有什么需要注意的事项。
4. **边界意识**: 只使用分配给你的工具集完成职责范围内的工作。不要越权访问其他 agent 的工具，不要修改未授权的文件。`

interface CreatePlanTaskInput {
  title: string
  description: string
  depends_on?: string[]
}

class CreatePlanTaskTool extends Tool {
  constructor(
    private taskManager: TaskManager,
    private subagentId: string,
    private createdIds: string[],
  ) { super() }
  get name(): string { return 'create_plan_task' }
  get description(): string {
    return 'Create a task in the kanban for the pipeline. Returns the new task id.'
  }
  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Full execution context for the generator (self-contained)' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'IDs of prerequisite tasks (empty for root)' },
      },
      required: ['title', 'description'],
    }
  }
  async execute(args: CreatePlanTaskInput): Promise<string> {
    try {
      const task = this.taskManager.create({
        title: args.title,
        description: args.description,
        depends_on: args.depends_on ?? [],
        subagent_id: this.subagentId,
      })
      this.createdIds.push(task.id)
      return `Created task ${task.id} (status=${task.status})`
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

interface PlannerState {
  runId: string
  subagentId: string
  createdIds: string[]
}

const stateByArgs = new WeakMap<object, PlannerState>()

function getState(args: Record<string, unknown>): PlannerState {
  let s = stateByArgs.get(args)
  if (!s) {
    const runId = crypto.randomUUID().slice(0, 8)
    s = { runId, subagentId: `plan-${runId}`, createdIds: [] }
    stateByArgs.set(args, s)
  }
  return s
}

export const plannerAgent: AgentDefinition = {
  name: 'planner',
  description:
    'Plan a complex task by reading an explore report and creating a root task plus dependency-ordered subtasks in the kanban. ' +
    'Returns the root task id and the list of created subtask ids. ' +
    'Does NOT execute or verify — coordinator dispatches generator/verifier on the created tasks.',
  systemPrompt: async (args) => {
    const userTask = (args.task as string) ?? ''
    let prompt = PLANNER_SYSTEM
    try {
      const relevantMemory = await recallRelevantMemory(userTask)
      if (relevantMemory) prompt = `${PLANNER_SYSTEM}\n\n## 相关记忆\n${relevantMemory}`
    } catch (err) {
      console.error('[planner] memory recall failed:', err)
    }
    return prompt
  },
  tools: [],
  maxTurns: 10,
  maxOutputTokens: 12000, // 任务 DAG + 自包含描述
  inputSchema: {
    properties: {
      task: { type: 'string', description: 'The high-level task to plan' },
      explore_report: { type: 'string', description: 'Codebase research report from the explore agent.' },
    },
    required: ['task'],
  },
  extraTools: (_ctx, args) => {
    const state = getState(args)
    return [new CreatePlanTaskTool(new TaskManager(), state.subagentId, state.createdIds)]
  },
  formatUserMessage: args => {
    const userTask = (args.task as string) ?? ''
    const exploreReport = (args.explore_report as string) ?? ''
    const exploreSection = exploreReport
      ? `## Explore Agent 调研报告\n${exploreReport}\n\n`
      : ''
    return (
      `用户原始任务：${userTask}\n\n` +
      exploreSection +
      `请按"需求澄清 → 拆解任务"两阶段工作。\n` +
      `通过 create_plan_task 创建：\n` +
      `1) root 任务（depends_on=[]，description 写完整需求文档：目标、验收标准、约束、假设）\n` +
      `2) 细粒度子任务（带依赖，description 自包含：涉及文件、具体改动、接口契约、注意事项、验收标准）\n` +
      `完成后输出一句话总结。`
    )
  },
  finalize: (_msgs, lastText, _ctx, args) => {
    const state = stateByArgs.get(args)
    const createdIds = state?.createdIds ?? []
    if (createdIds.length === 0) {
      return `[planner ${state?.runId ?? '?'}] 未创建任何任务，已终止。\n\n${lastText}`
    }
    const rootId = createdIds[0]
    const subIds = createdIds.slice(1)
    const lines = [
      `[planner ${state!.runId}] 计划已生成`,
      `Root: ${rootId}`,
      `Subtasks (${subIds.length}): ${subIds.join(', ') || '(none)'}`,
      ``,
      `下一步：作为 coordinator，循环执行 task(action=list, filter_status=todo) 找到下一个可做任务，`,
      `调用 generator 执行后用 verifier 审查；APPROVED → task 设为 done；NEEDS_REVISION → 把反馈追加到 description 后重置回 todo，最多重试 3 次。`,
    ]
    return lines.join('\n')
  },
}
