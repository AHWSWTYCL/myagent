import Anthropic from '@anthropic-ai/sdk'
import * as crypto from 'crypto'
import { createClient } from '../../client'
import { runAgentLoopStream } from '../../utils/runagent'
import { makePrefixedOnText } from '../../utils/agentutils'
import { ToolRegistrar } from '../toolregistrar'
import { Tool } from '../tool'
import { TaskManager } from '../../tasks/taskmanager'
import { recallRelevantMemory } from '../../memory/recall'

const PLANNER_SYSTEM = `你同时扮演两个角色：产品经理（PM） + 软件架构师。
在动手拆任务之前，先把"为谁做、做什么"搞清楚，再考虑"怎么做"。

工作流分三个阶段：

【阶段一 · 需求澄清（PM 视角）】
读懂用户原始任务，明确以下信息（在脑中完成即可，不必长篇输出）：
- 目标用户/受众是谁，他们的真实诉求是什么
- 核心目标与成功标准（验收条件）
- 关键约束：性能、兼容性、依赖、代码风格、不能触碰的部分
- 范围内 vs 范围外的事项
若用户的原始任务存在重大歧义且无法通过调研消除，可以采用合理假设并在 root 任务的描述里写明"采用了什么假设"。

【阶段二 · 代码调研（架构师视角）】
使用 read_file / list_dir / bash 调研代码库（只读），弄清：
- 相关模块/文件的位置和职责
- 既有约定（命名、测试、风格）
- 潜在的冲突点和复用点

【阶段三 · 拆解任务】
调用 create_plan_task 工具创建任务：
1. 首次调用必须创建 root 任务（depends_on=[]）。root 的 description 写完整的需求文档：目标用户、核心目标、验收标准、关键约束、采用的假设。这是 verifier 判定整体是否达成的依据。
2. 后续调用创建子任务，按依赖顺序排列，每个子任务必须 depends_on root 或前驱子任务，形成 DAG。粒度为"单文件级修改 / 一个函数 / 一组测试"，不要太粗也不要太细。
3. 子任务 description 必须**完全自包含** —— generator 看不到你的调研记录、聊天历史，也无法回头问你。每条子任务的 description 至少要包含：
   - 涉及的具体文件路径
   - 要做的具体改动（增/删/改了什么，关键代码片段或签名）
   - 输入与输出 / 接口契约
   - 注意事项（约束、需保留的行为、不要触碰的部分）
   - 验收标准（如何判断完成，如有可运行的检查命令请写出）

完成后输出一句话总结：root 任务 ID 是什么、共创建了几个子任务。不要自己动手实现，也不要调度 generator/verifier——主 agent 会作为 coordinator 来调度。`

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
  ) {
    super()
  }
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

function makeRegistrar(tools: Tool[]): { registrar: ToolRegistrar; exec: (n: string, i: unknown) => Promise<string> } {
  const registrar = new ToolRegistrar()
  for (const t of tools) registrar.registerTool(t)
  const exec = async (name: string, input: unknown): Promise<string> => {
    try {
      return await (registrar.getTool(name)?.execute(input as Record<string, string>) ?? Promise.resolve('Unknown tool'))
    } catch (err) {
      return `Error: ${err}`
    }
  }
  return { registrar, exec }
}

export class PlannerAgentTool extends Tool {
  get name(): string { return 'planner_agent' }
  get description(): string {
    return 'Plan a complex task by researching the codebase (read-only) and creating a root task plus dependency-ordered subtasks in the kanban. ' +
      'Returns the root task id and the list of created subtask ids. ' +
      'Does NOT execute or verify — the main agent (coordinator) is responsible for dispatching generator/verifier on the created tasks.'
  }
  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The high-level task to plan' },
      },
      required: ['task'],
    }
  }

  async execute(args: { task: string }): Promise<string> {
    const userTask = args.task
    const client = createClient()
    const tm = new TaskManager()
    const runId = crypto.randomUUID().slice(0, 8)
    const subagentId = `plan-${runId}`
    const createdIds: string[] = []

    const ReadTool = (await import('../readtool')).ReadTool
    const ListDirTool = (await import('../listdirtool')).ListDirTool
    const BashTool = (await import('../bashtool')).BashTool

    const createTaskTool = new CreatePlanTaskTool(tm, subagentId, createdIds)
    const planner = makeRegistrar([new ReadTool(), new ListDirTool(), new BashTool(), createTaskTool])

    let plannerSystem = PLANNER_SYSTEM
    try {
      const relevantMemory = await recallRelevantMemory(userTask)
      if (relevantMemory) {
        plannerSystem = `${PLANNER_SYSTEM}\n\n## 相关记忆\n${relevantMemory}`
        console.log(`[planner ${runId}] 已注入相关记忆 (${relevantMemory.length} 字符)`)
      }
    } catch (err) {
      console.error(`[planner ${runId}] 记忆召回失败，继续无记忆模式:`, err)
    }

    console.log(`\n[planner ${runId}] 调研并创建任务`)
    const planMessages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content:
          `用户原始任务：${userTask}\n\n` +
          `请按"需求澄清 → 代码调研 → 拆解任务"三阶段工作。\n` +
          `先调研代码库（read_file / list_dir / bash 只读），然后通过 create_plan_task 创建：\n` +
          `1) root 任务（depends_on=[]，description 写完整需求文档：目标、验收标准、约束、假设）\n` +
          `2) 细粒度子任务（带依赖，description 自包含：涉及文件、具体改动、接口契约、注意事项、验收标准）\n` +
          `完成后输出一句话总结。`,
      },
    ]
    await runAgentLoopStream({
      client,
      model: 'claude-sonnet-4-6',
      system: plannerSystem,
      tools: planner.registrar.getAllTools(),
      messages: planMessages,
      maxTurns: 15,
      executeTool: planner.exec,
      onText: makePrefixedOnText('[planner]'),
    })
    process.stdout.write('\n')

    if (createdIds.length === 0) {
      return `[planner ${runId}] 未创建任何任务，已终止。`
    }
    const rootId = createdIds[0]
    const subIds = createdIds.slice(1)
    const lines = [
      `[planner ${runId}] 计划已生成`,
      `Root: ${rootId}`,
      `Subtasks (${subIds.length}): ${subIds.join(', ') || '(none)'}`,
      ``,
      `下一步：作为 coordinator，循环执行 task(action=list, filter_status=todo) 找到下一个可做任务，`,
      `调用 generator 执行后用 verifier 审查；APPROVED → task 设为 done；NEEDS_REVISION → 把反馈追加到 description 后重置回 todo，最多重试 3 次。`,
    ]
    return lines.join('\n')
  }
}
