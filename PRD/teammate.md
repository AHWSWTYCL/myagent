这个是一个团队的隐喻，本质就是多agent
  的协调工作，通过基于文本的通信机制（跨进程和异步支持），这其实也是邮箱的一个隐喻，它解决1，任务的分派；2，进度和状态更新；3，关闭请求；4，权限
  等的申请。每个team由一个leader + N个teammate组成，teammate其实就是一个worker，它从任务队列（邮箱）获取分派的任务（这个任务由leader
  agent发分，本质是一个coordinator），这个worker在结束本次任务，将结果写入leader，或者其他teammate的邮箱总，然后会从邮箱中获取下一个任务，也可能
  是终止消息，这本本质也是一个loop。针对邮箱，每个teammate各种都有自己的邮箱，并和自己的agent id关联，这是它唯一的凭证。leader的职责是维护所有wo
  rker，给他们发分任务，并读取他们发来的邮件（任务的结果）做出决策，制定下一次的任务安排，worker需要制定它的leader是谁，以便向其报告（发邮件）任
  务的结果。邮箱的职责就是leader和teammates，或teammates之间的通信，需要包含必要的信息，1，发送者；2， 接收者； 3， 主题；
  4，摘要等。根据任务的关联程度，teammate之间也可以通信，汇报任务，或者指派任务，比如generator代码写完了，可以发消息给verifier让它验证，同时把进
  度汇报给leader当前任务的流向。teammate也可以主动冲task list poll相关任务去完成。


# 以下是最新的补充，看看目前有没有实现，没有要实现一下
- 实现TeamCreate Tool，目的是创建一个team，基于文件实现，需要用team name，可以类比为给teammate创建一个房间
- 在agent tool或者system prompt中说明如何spawn 一个teammate，并将它加入的指定的team中，同时修改agent tool实现，以便llm决定要spawn 一个teammate

---

## 实现进展（2026-06-06）

### 已完成

**1. 文件式邮箱模块** — `src/mailbox/mailbox.ts`
每个 agent 一个目录 `~/.myagent/mailbox/<agent_id>/`，每封信一个 JSON 文件。已读移到 `read/` 子目录而非删除（便于排查）。API：`send` / `list` / `popFirst` / `markRead` / `destroy`。跨进程安全。

支持的邮件 kind：`task | result | status | close | permission`，含 from / to / subject / body / meta / created_at 字段。

**2. 邮件工具** — `src/tools/sendmailtool.ts` + `src/tools/checkmailtool.ts`
- `send_mail`：构造时绑定 selfId 作 from，agent 不需要每次填发件方
- `check_mail`：`peek`（不消费，可 limit）/ `pop`（消费最早一封并标记已读）两种模式

**3. leader / teammate agent 定义** — `src/agents/builtin/{leader,teammate}.ts`
- **leader** 工具集：`start_teammate / send_mail / check_mail`。不能直接读写文件或跑命令，所有实际工作通过 teammate 完成。
- **teammate** 是 worker loop：`pop` 邮件 → 按 kind 处理 → 完成后 `send_mail` 回报 → 邮箱空时主动发 idle 心跳。工作工具通过 `tools="bash,read_file,..."` 字段动态注入，从主 toolRegistrar 拷贝。

**4. start_teammate 工具** — `src/tools/startteammatetool.ts`
leader 专用工厂工具，做了两件保护：
- 物理上不让 leader 漏 `background=true`（schema 不暴露该字段，内部强制）
- 预先把 initial task 写进 teammate 邮箱再启动 worker，解决"worker 启动比 leader 派活更早 → 立刻 idle"的 race condition

**5. teammate idle 行为**
邮箱空时第一时间 `send_mail` 给 leader 报 idle（subject="idle"，meta 带 idle_count），再立刻结束本轮 turn 不空转。leader prompt 同步要求收到 idle 邮件后立即派活、`close`、或显式回执，不让 teammate 重复心跳浪费 token。teammate 累计 5 次 idle 仍无任务则自行退出。

**6. `/team` 斜杠命令** — `src/commands/teamcommand.ts`
一行 `/team <task>` 把 prompt 入队，让主 agent 用 `background=true` 调 leader。避开 sub-agent 同步 stream abort 路径。

**7. debug headless 加 `--wait-for-bg [秒]`** — `src/debug.ts` + `src/agent.ts`
解决 headless 下"主 turn 短、leader 后台跑很久"被截断。主 turn 完成后轮询 `bgManager` 直到所有 running 任务终结，过程中 bg-task 通知会自然 push 到 messages，最终 JSON 输出含 leader 完整总结。

**8. 端到端实跑验证**
debug headless 命令实测通过：
```
npx tsx src/agent.ts --debug "..." --auto-yes --wait-for-bg 240
```
完整邮件链路：leader → wk1 [task] → wk1 → leader [result] → wk1 → leader [status idle] → leader → wk1 [close]。主 agent 收到两个 `<bg-task>` 通知含 leader 写的最终总结表格。

### 设计原则

- 老的 coordinator / generator / verifier / planner 流水线一行未动并存，新功能完全独立
- 文件式存储跨进程可观测：直接 `ls ~/.myagent/mailbox/<agent>/` 看队列状态
- 工具自动绑定调用方 id，agent prompt 不需要操心 from 字段

### 未完成

**A. TUI 邮箱可视化面板**
没动 TUI 层。日常 `npm run agent` 用 `/team` 跑时邮件流只能查目录看文件。仿照已有的 todo / task panel 风格做不复杂，但工程量比这次大。

**B. 回归测试套件**
写过 `src/__tests__/mailbox.test.ts`，但 vitest 4 + rolldown 本机装不起来（`Cannot find module '@rolldown/binding-darwin-arm64'`），随后清理删除。要纳入 CI 需先解决 vitest/rolldown 安装问题或换回 vitest 3。

**C. 权限申请协议**
邮件 kind 保留了 `permission` 字段，但没有完整链路：teammate 没有"需要 X 权限 → 发 permission 邮件 → leader 批准 → 继续"的实际行为。

**D. teammate 主动 poll TaskManager**
PRD 提到"teammate 也可以主动从 task list poll 相关任务"。当前 teammate 只从邮箱取任务，没有让它去 `TaskManager` 主动认领 `subagent_id=自己 && status=todo` 的任务。`TaskManager` 已有该字段，可以做但本轮没碰。

**E. LLM 级 peer 协作实跑**
peer 协作只在 mailbox API 层做了模拟（无 LLM 参与），证明协议层支持。teammate.ts 已写了 `peers` 协作约定，但缺一次真实 LLM 调用下两个 teammate（如 generator + verifier 通过 `peers` 字段互发 send_mail）端到端跑通的验证。

**F. 多 teammate 并行**
所有真实跑都是 1 leader + 1 teammate。多 teammate 并行 + leader 同时消费多个邮箱链路没实跑过。理论上 mailbox 按目录隔离应该 work，但未验证。

**G. 失败 / 超时结构化处理**
teammate 工作工具调用失败（如 bash 报错）目前依赖 prompt 中"先看 result body 诊断再决定改派/重试/放弃"的指引处理，没有结构化失败邮件 kind。idle_count 达到 5 自行退出写在 prompt 里，没在代码层硬性约束。

**H. 文件锁**
mailbox 写文件未加锁。多个进程同时写同一收件箱在极端 race 下可能损坏 JSON。短期看不会触发（每个 agent 写不同收件人目录），产品级使用需补。

### 后续优先级建议

1. **E** — 真实 LLM peer 协作端到端跑通（直接给 PRD 核心主张兜底）
2. **F** — 多 teammate 并行（验证 PRD 设计是否扩展性 ok）
3. **A** — TUI 邮箱面板（体验提升）
