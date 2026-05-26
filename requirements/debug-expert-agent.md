# debug_expert：诊断和调试专家 sub-agent

> 状态：DRAFT | 作者：analyst agent | 日期：2025-07-16

## 1. 背景与动机

现有的 sub-agent 流水线存在一个缺口：
- **bug_intake** 只负责记录 bug 现象、复现步骤、影响范围，**不定位根因、不修代码**，产出是 bugs/*.md 报告。
- **explore** 只做只读代码调研，产出的是代码结构报告，**不做根因推断**。
- **general-purpose** 可以执行任务但缺少专业诊断的系统性约束。

当 coordinator 需要「拿到 bug 报告 → 定位根因 → 出修复方案 → 交给 generator 修」时，中间缺少一个专门负责**诊断推理**的环节。debug_expert 填补的就是这个缺口：它消费 bug_intake 的 bug 报告（和可选的 explore 调研报告），在代码库中进行系统性排查，输出根因分析 + 混合粒度的修复方案，然后交给 downstream（generator）实施修复。

## 2. 目标用户与典型场景

- **角色 A：coordinator agent** — 在 bug 修复流水线的中间环节调用 debug_expert。典型的一次会话：
  1. coordinator 拿到 bug_intake 产出的 bug 报告
  2. （可选）调用 explore 做只读代码调研
  3. 调用 `agent(agent="debug_expert", task=..., bug_report=..., explore_report=..., context=...)`
  4. debug_expert 读代码、查日志、打临时补丁验证，返回根因分析 + 修复方案文本
  5. coordinator 将修复方案交给 planner → generator → verifier 实施修复

- **角色 B：human user（间接）** — 用户通过 bug_intake 提交 bug 后，debug_expert 可能在分析遇到瓶颈时用 ask_user 向用户追问更多线索（如环境细节、特定操作步骤等）。

## 3. 核心目标（In Scope）

1. **消费 bug_report 做根因分析** — 接收 bug_intake 产出的结构化 bug 报告（含症状、复现步骤、环境等），基于代码库进行系统性排查，定位根因。
2. **读代码 + 检查运行时状态 + 分析日志** — 使用 read_file / grep / glob / bash（完整权限）等工具读源码、查看日志、检查进程和环境变量。
3. **打临时补丁验证假设** — 可用 bash（含写文件权限）安装调试依赖、打临时补丁验证根因假设；验证后恢复非日志改动，并在最终报告中标注残留的调试日志。
4. **产出结构化诊断报告** — 文本形式返回给 coordinator，包含以下章节：
   - 排查过程（读了哪些文件、做了哪些检查、验证了哪些假设）
   - 根因分析（确认的根因是什么）
   - 修复方案（自然语言 + 关键代码片段，混合粒度）
   - 残留的调试改动（如果有，标注在哪些文件加了什么日志）
   - 未排查的假设（如果有，时间不够或无法验证的次要可能）
5. **分析遇到瓶颈时向用户求助** — 当无法定位根因（日志不够、无法复现、代码太复杂）时，使用 ask_user / ask_user_choice 向用户追问更多线索。
6. **修复方案保持混合粒度** — 方案以自然语言描述为主，辅以关键代码片段示例，让 generator 能完全理解并实施；不生成精确 diff/patch。

## 4. 不做（Out of Scope）

- **不代替 bug_intake 做症状追问** — debug_expert 不负责从零开始问「你看到了什么现象」，它消费现成的 bug_report。除非 bug_report 信息严重不足，才用 ask_user 补缺。
- **不直接改代码实施修复** — debug_expert 不调用 write_file 做最终修复（write_file 只在写自己分析过程需要时使用，如写中间文件）；修复代码由 generator 实施。
- **不代替 explore 做全面只读调研** — explore 产出的是代码结构「地图」，debug_expert 产出的是根因「诊断」。如果 explore_report 已提供，debug_expert 优先消费它跳过重复调研；但不强制依赖 explore。
- **不做并发保护** — v1 不实现锁机制或工作区隔离；coordinator 应自行调度避免并发冲突。
- **不做持久化文件存档** — 分析结果以文本形式返回 coordinator，不写文件到磁盘（不需要 debug/ 目录）。

## 5. 验收标准（AC）

**AC1：接受 bug_report 进行根因分析**
- Given 一份由 bug_intake 产出的完整 bug 报告（含症状、复现步骤、环境）
- When debug_expert 被调用并传入该 bug_report
- Then 它应基于代码库进行系统性排查，最终返回包含根因分析的文本报告

**AC2：打临时补丁验证假设并恢复**
- Given debug_expert 正在分析一个需要验证的根因假设
- When 它选择用 bash（如 sed -i）修改文件来验证
- Then 验证后应恢复非日志类的改动；若加了调试日志，在最终报告中标明「哪些文件加了什么日志，建议后续清理」

**AC3：无法定位根因时向用户求助**
- Given debug_expert 经过多轮排查仍无法定位根因
- When 它判断当前信息不足以得出结论
- Then 应使用 ask_user / ask_user_choice 向用户追问更多线索（如环境细节、操作步骤、日志等），并在最终报告中列出已排查的假设和排除了哪些可能

**AC4：输入信息不足时主动澄清**
- Given debug_expert 被调用时 bug_report 为空或严重不足（如只有「它坏了」三个字）
- When 它无法开展有效诊断
- Then 应使用 ask_user 追问更多细节，或返回错误信息说明需要先走 bug_intake 流程

**AC5：输出格式包含全部必要章节**
- Given debug_expert 完成了根因分析
- When 它生成最终文本报告返回给 coordinator
- Then 报告必须包含「排查过程、根因分析、修复方案、残留改动（如有）、未排查假设（如有）」五个章节

**AC6：修复方案为混合粒度**
- Given debug_expert 确定了根因
- When 它输出修复方案
- Then 方案应包含自然语言描述 + 关键代码片段示例，覆盖「改哪个文件、改什么、为什么改」

**AC7：优先消费 explore_report 避免重复劳动**
- Given coordinator 同时传入了 bug_report 和 explore_report
- When debug_expert 开始分析
- Then 应优先阅读 explore_report 获取代码结构上下文，跳过重复的全面文件浏览

**AC8：不写入最终修复代码**
- Given debug_expert 完成了根因分析和修复方案
- When 它返回结果给 coordinator
- Then 不应调用 write_file 或其他工具修改业务代码来实施修复

## 6. 输入 / 输出契约

### 输入（inputSchema）

```
{
  task: string,           //（必需）原始任务描述
  bug_report: string,     //（必需）bug_intake 产出的 bug 报告全文
  explore_report?: string,//（可选）explore 的调研报告，有则优先消费
  context?: string,       //（可选）调用方已收集的其他上下文（日志片段、历史对话等）
}
```

### 输出

纯文本字符串，通过 agent runner 的 `lastText` 返回给 coordinator。文本结构如下：

```
## 排查过程
（读了哪些文件、做了哪些检查、验证了哪些假设）

## 根因分析
（确认的根因是什么）

## 修复方案
（自然语言描述 + 关键代码片段示例）

## 残留的调试改动
（如有，列出文件名和添加的日志内容，建议清理）

## 未排查的假设
（如有，列出次要可能及未能验证的原因）
```

### 工具列表

| 工具名 | 用途 | 备注 |
|---|---|---|
| read_file | 读代码文件 | 核心诊断工具 |
| list_dir | 列出目录 | 辅助定位 |
| grep | 代码搜索 | 核心诊断工具 |
| glob | 文件模式匹配 | 辅助定位 |
| bash | 执行诊断命令 + 打临时补丁验证 | **完整权限**（含写入），但需遵守临时改动约束 |
| ask_user | 向用户追问线索 | 瓶颈时使用 |
| ask_user_choice | 向用户提供选项 | 瓶颈时使用 |
| websearch | 搜索外部资料辅助诊断 | **v1 标注依赖**：需先建设 websearch 工具 |

## 7. 边界 Case 与失败处理

| 场景 | 处理方式 |
|---|---|
| **bug_report 为空或严重不足** | 用 ask_user 追问更多细节；若用户也无法补全，返回错误信息说明需先走 bug_intake 流程 |
| **无法定位根因** | 用 ask_user 向用户求助，提供已排查的假设清单和排除的路径；最终报告中列出排查过的假设 |
| **临时补丁验证后未恢复** | 约束在 system prompt 中：每次验证后必须恢复非日志改动；若中途中断/超时，假设代码库可能处于脏状态（标注为假设） |
| **并发调用** | coordinator 应避免同时触发两个 debug_expert 实例修改同一代码库；v1 不实现锁机制（标注为未决问题） |
| **bash 命令执行失败** | 捕获错误并在排查过程中记录，尝试替代方案或降级为纯静态分析 |
| **工具被拒绝（权限拦截）** | 记录被拒绝的操作，尝试替代方法；若核心诊断路径被堵，报告受限并说明原因 |
| **用户中途取消** | 通过系统信号/超时机制自然终止；已产生的临时改动需要人工检查（标注为假设） |
| **缺少 websearch 工具** | 降级为仅靠代码库本地分析；需求文档已标注 websearch 为前置依赖 |

## 8. 与现有系统的关系

### 复用
- **AgentDefinition 接口** — 复用现有 `definition.ts` 的 `AgentDefinition`、`AgentInputSchema`、`AgentRunContext` 类型
- **AgentRegistry** — 通过 `registry.register()` 注册，复用现有发现机制
- **工具系统** — 复用 read_file、list_dir、grep、glob、bash、ask_user、ask_user_choice、write_file 等工具
- **runner.ts** — 复用 `runAgent()` 执行逻辑，包括 systemPrompt 异步求值、formatUserMessage、extraTools 工厂、finalize 钩子
- **memory 召回** — 复用 `recallRelevantMemory` 机制，在 systemPrompt 中注入相关记忆

### 改写
- 无需要改写的现有代码

### 绝对不动
- **bug_intake 的职责边界** — bug_intake 只记录症状和复现，debug_expert 不做症状追问
- **explore 的职责边界** — explore 只做只读代码调研，debug_expert 做根因推断；两者有重叠但分工不同
- **generator 的职责边界** — generator 负责实施代码修复，debug_expert 只产出方案不动手
- **coordinator 的调度逻辑** — 不修改 coordinator 的流水线编排代码

## 9. 非功能约束

| 维度 | 约束 |
|---|---|
| **maxTurns** | 40 轮（比 bug_intake 和 explore 都多，适应复杂诊断场景） |
| **模型** | 使用默认模型（当前为 claude-sonnet-4-6） |
| **输出可见度** | 文本返回给 coordinator coordinator 可见；不落盘为文件 |
| **持久化** | 不做跨 session 持久化；每次调用独立分析 |
| **websearch 依赖** | v1 需要先建设 websearch 工具（当前代码库中不存在），需求文档标注为前置依赖 |
| **代码库干净度** | 临时改动约束：验证后恢复非日志改动；残留的调试日志需在报告中标注 |
| **可观察性** | debug_expert 的排查过程在 emitLine 中输出（带 [debug_expert] 前缀），coordinator 可观察中间步骤 |

## 10. 假设与未决问题

### 假设
1. **bug_report 通常是完整的** — 调用方（coordinator）会在调用 debug_expert 前确保 bug_intake 已完成 bug 报告撰写；空报告是少数情况。
2. **并发不会发生** — v1 假设同一时间只有一个 debug_expert 实例在运行；coordinator 不会并发触发多个调试会话修改同一代码库。
3. **bash 工具可用且不受限** — debug_expert 拥有完整 bash 权限（含写入），但受 system prompt 约束只用于诊断和临时验证。
4. **临时改动的回滚靠自觉** — system prompt 约束 debug_expert 每次验证后恢复非日志改动；但无强制性保护机制，中途中断可能导致脏状态。

### 未决问题
1. **websearch 工具何时建设？** — debug_expert v1 需要 websearch 来搜索外部资料，但当前代码库中没有该工具。需 planner 决策：先建 websearch 再集成，还是 v1 先不用、以后再加。
2. **是否需要锁机制？** — 并发调用可能导致临时改动冲突。v1 不做处理，但未来版本可能需要实现文件锁或工作区隔离。留给 planner 评估优先级。
3. **修复方案是否要进 kanban？** — 目前 debug_expert 直接返回文本给 coordinator；是否将修复方案写入 kanban task 的 description 或附件，由 coordinator/planner 决定。
