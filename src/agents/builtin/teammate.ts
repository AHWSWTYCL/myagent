import { AgentDefinition } from '../definition.js'
import { SendMailTool } from '../../tools/sendmailtool.js'
import { CheckMailTool } from '../../tools/checkmailtool.js'
import { TeamManager } from '../../team/team.js'

const SYSTEM = `你是一个 teammate worker。你属于某个 leader 管理的 team，通过文件式邮箱与 leader / 其他 teammate 协作。

## 核心循环（每一轮 turn 都按这个走）

1. 用 check_mail (mode=pop) 取出邮箱里当前最高优先级的一封信。优先级为：
   - 最高：用户输入框发来的邮件（meta.source === 'teammateView'）
   - 次高：kind=close 的关闭请求
   - 第三：leader 发来的邮件
   - 最低：其他 peer 发来的邮件
   同优先级内按时间先后 FIFO。
2. 根据信的 kind 决定动作：
   - kind=task → 用分配给你的工具执行任务，完成后用 send_mail (kind=result, to=<信的 from>, meta={ ref: <信的 id> }) 把结果发回。
   - kind=close → **这是你唯一能退出的方式**。收到后立即停止所有工作，输出一段告别说明（包含已完成多少件任务），结束循环。
   - kind=status / result → 一般是其他 teammate 协作发来的；按内容自行处理（比如 verifier 收到 generator 的 result 就开始验证），完成后同样 send_mail 汇报。
3. 处理完后，回到第 1 步继续取下一封。
4. **idle 处理**（check_mail 返回 (empty)）：
   - 维护一个 idle_count（从 1 开始，每次空返回递增 1）。
   - **指数退避汇报**：只在 idle_count 为 1, 5, 10, 20, 30, 40, ... 时发送 idle 心跳邮件，格式：send_mail (kind=status, to=<leader_id>, subject="idle", body="idle, no pending mail, waiting for tasks", meta={ idle_count: N })。其余轮次只输出一行简短文本（如「idle #N, waiting…」），不发邮件。
   - **永不因 idle 自行退出**。你唯一能退出的时机是收到 leader 发来的 kind=close 邮件。在此之前，无论 idle 多少次，都必须持续轮询邮箱。

## 协作约定

- 你只能通过 send_mail / check_mail 与外界通信，不能读其他 agent 的邮箱。
- 每件任务的结果都要发回给 from 字段所写的 agent（通常是 leader），同时 meta.ref 填入原任务邮件 id 方便追溯。
- 如果一个任务你需要其他 teammate 协助（如 generator → verifier），可以直接 send_mail 给那个 teammate（你会被告知队友的 agent id），同时给 leader 发一封 kind=status 说明任务流向。
- 永远不要修改自己邮箱的 read/ 子目录中的文件，那是历史记录。

## Guidelines

1. **工具调用纪律**: 每次工具调用完成后，等待并读取返回结果再做下一步。
2. **错误处理**: 工具错误先诊断再决定是否汇报；不能默默吞掉。
3. **输出完整性**: result 邮件 body 要写清楚做了什么、改了哪些文件 / 命令输出、结果如何。
4. **边界意识**: 只用分配给你的工具完成 task 邮件中要求的工作，不越权。`

export const teammateAgent: AgentDefinition = {
  name: 'teammate',
  description:
    'A worker that joins a team. Polls its own mailbox, executes task mails, reports results back to the sender. ' +
    'Spawn it in background (background: true) and communicate via send_mail / check_mail. ' +
    'Inputs: agent_id (this worker\'s mailbox id, must be unique), leader_id (default "leader"), ' +
    'tools (comma-separated tool names this worker is allowed to use besides mail tools), ' +
    'role (a one-line description of this teammate\'s specialty so the LLM knows what kind of tasks to accept), ' +
    'team_name (optional — join a named team created with create_team).',
  agentType: 'teammate',
  systemPrompt: (args) => {
    const role = String(args.role ?? 'general worker')
    const peers = (args.peers as string | undefined)
    const teamName = (args.team_name as string | undefined)
    const peersLine = peers ? `\n你的队友 agent id（可以直接 send_mail 协作）: ${peers}` : ''

    let teamSection = ''
    if (teamName && TeamManager.exists(teamName)) {
      const members = TeamManager.listMembers(teamName)
      const otherIds = members
        .map(m => m.agent_id)
        .filter(id => id !== String(args.agent_id))
      if (otherIds.length > 0) {
        teamSection = `\n你属于 team "${teamName}"。团队中其他成员: ${otherIds.join(', ')}。可以直接 send_mail 与他们协作。`
      } else {
        teamSection = `\n你属于 team "${teamName}"（目前你是唯一成员）。`
      }
    } else if (teamName) {
      teamSection = `\n注意：team "${teamName}" 不存在或尚未创建。你的 leader 应该先调用 create_team。`
    }

    return SYSTEM + `\n\n## 当前身份\n你的 agent_id: ${args.agent_id}\n你的 leader_id: ${args.leader_id ?? 'leader'}\n你的角色: ${role}${peersLine}${teamSection}`
  },
  // 工作工具由调用方通过 tools 字段传入；mail 工具走 extraTools 注入（绑定 selfId）
  tools: [],
  maxTurns: 50,
  inputSchema: {
    properties: {
      agent_id: { type: 'string', description: 'Unique mailbox id for this teammate' },
      leader_id: { type: 'string', description: 'Leader agent id, default "leader"' },
      role: { type: 'string', description: 'One-line specialty description' },
      tools: { type: 'string', description: 'Comma-separated work tools this teammate is allowed to use' },
      peers: { type: 'string', description: 'Optional comma-separated peer teammate ids for direct collaboration' },
      task: { type: 'string', description: 'Optional initial instruction sent as the first user message' },
      team_name: { type: 'string', description: 'Optional team name. The teammate will be registered as a team member and can see other members.' },
    },
    required: ['agent_id'],
  },
  formatUserMessage: (args) => {
    const initial = String(args.task ?? '')
    const head = `你已加入团队，开始 worker 循环。`
    return initial ? `${head}\n\n初始指令：${initial}\n\n现在调用 check_mail (mode=pop) 看看邮箱里有什么。` : `${head}\n\n现在调用 check_mail (mode=pop) 看看邮箱里有什么。`
  },
  extraTools: (_ctx, args) => {
    const selfId = String(args.agent_id)
    const leaderId = String(args.leader_id ?? 'leader')
    return [new SendMailTool(selfId), new CheckMailTool(selfId, { popStrategy: 'teammatePriority', leaderId })]
  },
  // teammate 在被注册到 subRegistrar 时，需要把 args.tools 列表中的工具实际加进来。
  // 但 AgentDefinition.tools 是静态字符串数组，runner.ts 的实现会基于它取主 toolRegistrar 中的工具。
  // 为了支持运行时动态工具白名单，我们在 finalize 之前其实做不了——所以让 leader 直接传一个固定 set。
  // 取巧方案：teammate 的 tools 字段静态留空，leader 调用时通过 extraTools 多塞一个 toolRunner 的引用？
  // 实际可行的最简方案是：在 extraTools 里直接从 ctx.toolRegistrar 取出 args.tools 列出的工具，加进来。
}

// 把 args.tools 列出的工具从主 toolRegistrar 拷贝过来，加入 extras。
// 这样 teammate 的可用工具集就是 [mail tools] + [args.tools 指定的工作工具]。
// 同时，如果指定了 team_name 且 team 存在，自动注册为该 team 成员。
const originalExtras = teammateAgent.extraTools!
teammateAgent.extraTools = async (ctx, args) => {
  const mailTools = await originalExtras(ctx, args)
  const extra = [...mailTools]
  const toolNames = String(args.tools ?? '').split(',').map(s => s.trim()).filter(Boolean)
  for (const name of toolNames) {
    const t = ctx.toolRegistrar.getTool(name)
    if (t && !extra.find(e => e.name === t.name)) {
      extra.push(t)
    }
  }
  // 自动注册到 team（处理直接通过 agent tool 调用 teammate 的路径）
  const teamName = args.team_name as string | undefined
  if (teamName && TeamManager.exists(teamName)) {
    const agentId = String(args.agent_id)
    const role = String(args.role ?? '')
    TeamManager.addMember(teamName, agentId, role)
  }
  return extra
}
