# Attachment 机制与 Context Engineering

## 1. 什么是 Attachment

`Attachment` 是 Claude Code 的**上下文注入抽象**。每轮对话开始、LLM API 调用前，系统自动收集当前状态的各个切面，打包成 attachment，注入到上下文里。

它是一个判别联合类型（discriminated union），约 50 种变体，每个变体有 `type` 字段：

```typescript
export type Attachment =
  | FileAttachment            // @提及的文件
  | { type: 'todo_reminder' } // 任务提醒
  | { type: 'plan_mode' }     // 计划模式状态
  | { type: 'hook_success' }  // hook 执行结果
  // ... 约 50 种
```

---

## 2. Attachment 的生命周期

```
用户提交输入
    ↓
getAttachments()          ← 收集所有当前状态（并行，1秒超时）
    ↓
createAttachmentMessage() ← 包装成内存消息对象 (type='attachment')
    ↓
normalizeAttachmentForAPI() ← 转成 Anthropic API 格式 UserMessage[]
    ↓
mergeUserMessages()       ← 合并进同一个 user turn
    ↓
LLM API 调用
```

三层分离：**数据层 → 内存消息层 → API 格式层**。

---

## 3. 收集阶段：getAttachments()

`getAttachments()` 在每轮提交前运行，把所有 getter 分三组**并行**执行：

```
getAttachments(input, toolUseContext, ideSelection, queuedCommands, messages)
  │
  ├── userInputAttachments     ← 响应用户输入（@文件、MCP资源、@agent、skill discovery）
  ├── allThreadAttachments     ← 主线程 + 子 Agent 共用
  │     queued_command, changed_files, nested_memory,
  │     plan_mode, todo_reminder, teammate_mailbox, date_change ...
  └── mainThreadAttachments    ← 仅主线程
        ide_selection, diagnostics, token_usage, budget_usd ...
```

每个 getter 用 `maybe(label, fn)` 包裹——出错返回 `[]` 不崩溃，采样 5% 写 analytics。

---

## 4. 所有 Attachment 类型

### 文件/内容注入

| type | 触发场景 |
|------|---------|
| `file` | 用户 @提及文件 |
| `already_read_file` | FileReadTool 读过的文件（变更时重注入） |
| `compact_file_reference` | 压缩模式下只注入路径引用，不含内容 |
| `pdf_reference` | 大 PDF 只记引用 |
| `edited_text_file` / `edited_image_file` | 被编辑的文件 diff/内容 |
| `directory` | @提及目录 |
| `mcp_resource` | @提及 MCP server 资源 |

### IDE 集成

| type | 内容 |
|------|------|
| `selected_lines_in_ide` | 当前 IDE 选中的代码范围 |
| `opened_file_in_ide` | 当前在 IDE 打开的文件路径 |
| `diagnostics` / `bagel_console` | IDE 诊断信息、浏览器控制台错误 |

### Memory 系统

| type | 内容 |
|------|------|
| `nested_memory` | 子目录的 CLAUDE.md 内容 |
| `relevant_memories` | auto-memory 向量检索出的相关记忆（最多5个/轮，4KB/个） |
| `current_session_memory` | 当前会话摘要记忆 |

### 任务/计划状态

| type | 内容 |
|------|------|
| `todo_reminder` / `task_reminder` | 每 10 轮提醒一次未完成任务 |
| `plan_mode` / `plan_mode_reentry` / `plan_mode_exit` | 进入/重入/退出计划模式 |
| `plan_file_reference` | 计划文件当前内容 |
| `verify_plan_reminder` | 提醒验证计划（每 10 轮） |
| `task_status` | 子 Agent 任务状态变更 |
| `auto_mode` / `auto_mode_exit` | 自动模式进出 |

### Skill 系统

| type | 内容 |
|------|------|
| `skill_listing` | 可用 skill 列表（首次完整 + 变化时增量） |
| `dynamic_skill` | 动态加载的 skill 目录内容 |
| `invoked_skills` | 本轮调用了哪些 skill |
| `skill_discovery` | AKI 搜索推荐的相关 skill |

### 工具/权限动态变化

| type | 内容 |
|------|------|
| `deferred_tools_delta` | 工具集增减（增量，避免每轮全量） |
| `agent_listing_delta` | 可用 Agent 类型增减 |
| `mcp_instructions_delta` | MCP server 自定义指令增减 |
| `command_permissions` | `--allowedTools` 限制 |

### Hooks

| type | 内容 |
|------|------|
| `async_hook_response` | 异步 hook 执行结果 |
| `hook_success` / `hook_cancelled` / `hook_blocking_error` 等 | hook 各种执行状态 |
| `hook_additional_context` | hook 注入的额外上下文 |
| `hook_permission_decision` | hook 修改权限决策 |

### Teammate/Swarm

| type | 内容 |
|------|------|
| `teammate_mailbox` | 其他 Agent 发来的 DM |
| `team_context` | 当前 Agent 的团队身份 |
| `teammate_shutdown_batch` | 批量关闭通知 |

### 系统级控制

| type | 内容 |
|------|------|
| `queued_command` | 队列中的用户消息（含 task-notification 系统事件） |
| `date_change` | 日期跨天时注入新日期 |
| `token_usage` / `budget_usd` / `output_token_usage` | 资源用量 |
| `max_turns_reached` | 达到最大轮数 |
| `compaction_reminder` / `context_efficiency` | 上下文管理提示 |
| `ultrathink_effort` | 检测到 ultrathink 关键词 |
| `critical_system_reminder` | 关键系统指令 |
| `structured_output` | SDK 模式下的结构化输出 |

---

## 5. 渲染阶段：normalizeAttachmentForAPI()

把 `AttachmentMessage` 转成 Anthropic API 格式时，用了两种主要策略：

### 策略一：伪造工具调用对

```typescript
case 'file':
  return wrapMessagesInSystemReminder([
    createToolUseMessage(FileReadTool.name, { file_path: attachment.filename }),
    createToolResultMessage(FileReadTool, fileContent),
  ])

case 'directory':
  return wrapMessagesInSystemReminder([
    createToolUseMessage(BashTool.name, { command: `ls ${attachment.path}` }),
    createToolResultMessage(BashTool, { stdout: attachment.content }),
  ])
```

文件/目录内容不是直接塞文字，而是包装成"我刚才调用了 FileReadTool/BashTool，这是结果"的形式。模型看到的是它**训练时见过的标准结构**，对文件内容的来源归因正确。

### 策略二：`<system-reminder>` 包裹的 user message

```typescript
case 'edited_text_file':
  return wrapMessagesInSystemReminder([
    createUserMessage({
      content: `Note: ${attachment.filename} was modified...`,
      isMeta: true,
    })
  ])
```

`<system-reminder>` XML 标签告诉模型这是系统注入的元信息，不是用户输入。`isMeta: true` 表示不显示给用户。

### 合并逻辑

多个 attachment 转成的 `UserMessage[]` 会被合并进同一个 user turn，避免连续多个 user message（API 要求 user/assistant 严格交替）：

```typescript
if (lastMessage?.type === 'user') {
  result[result.length - 1] = attachmentMessage.reduce(
    (p, c) => mergeUserMessagesAndToolResults(p, c),
    lastMessage,
  )
}
```

---

## 6. 格式对 LLM 理解的影响

这是 context engineering 最反直觉的地方：**同样的信息，格式不同，模型理解质量差异巨大**。

```
// 方式A：直接注入文字
"utils.ts 的内容是：\nfunction foo() {...}"

// 方式B：伪造工具调用（Claude Code 实际做法）
assistant: tool_use FileReadTool { file_path: "utils.ts" }
user:      tool_result "function foo() {...}"
```

方式 B 激活的是模型训练时学到的"我读了某个文件"的行为模式，对文件内容的理解和引用更准确。

三种信息来源对应三种格式，模型可以清晰区分：
- 用户说的话 → 裸 text
- 系统注入的元信息 → `<system-reminder>` 包裹
- 工具执行结果 → `tool_result`

**本质：格式选择是在选择激活模型的哪套行为模式。** LLM 通过 token 序列上的模式匹配工作，给它的格式越贴近训练数据分布，行为就越可预测。

---

## 7. Context Engineering 核心维度

### 内容选择（What）

**全量 vs 增量**：`deferred_tools_delta` 只推工具集的变化，不每轮重复几十个工具描述。

**相关性过滤**：`relevant_memories` 用向量检索从几十个 memory 文件里选最相关的5个。无关信息是对注意力的稀释。

### 时机（When）

**首次 vs 增量**：`skill_listing` 区分 `isInitial`——首次完整注入，后续只推变化。

**频控**：`todo_reminder` 每 10 轮注入一次。太频繁浪费 token；太稀疏模型忘记任务状态。

**事件驱动**：`date_change` 只在日期跨天时注入，`edited_text_file` 只在文件被修改后注入。

### 格式（How）

见第 6 节。工具调用对 vs `<system-reminder>` vs 裸文本，对应不同的信息来源和语义。

### Prompt Cache 友好性（Stability）

**`relevant_memories` 的 header 预计算**是典型案例：

```typescript
// 错误：每轮 render 时调用 Date.now()
`saved ${memoryAge(mtimeMs)} ago`  // "3 days ago" → "4 days ago" → cache miss

// 正确：创建时计算一次，存入 attachment
header: `saved 3 days ago`  // 稳定不变 → cache 命中
```

Anthropic prompt cache 基于前缀哈希，5 分钟 TTL。context 里任何一字节变化都会导致 cache miss，重付全量 token 费用。

### 作用域（Scope）

子 Agent 不处理 `ide_selection` 和 `token_usage`——这些是主线程专属。三层隔离（userInput / allThread / mainThread）确保每个 Agent 只收到对它有意义的信息。

---

## 8. Push vs Pull

Attachment 是**推送模型**：系统决定模型需要什么，在每轮开始前主动注入。

与之对比的是**拉取模型**：模型自己决定需要什么，通过工具调用去读取（如 FileReadTool、WebSearch）。

| | Push（Attachment） | Pull（工具调用） |
|--|--|--|
| 延迟 | 低（并行预取） | 高（额外 round trip） |
| 可控性 | 高 | 低 |
| 灵活性 | 低（需预判） | 高（模型自主） |
| 维护成本 | 高（规则维护） | 低 |

Claude Code 的实践是两者结合：稳定的、高频需要的信息 push（文件变更、任务状态、IDE 选中）；动态的、偶尔需要的信息留给 pull（读取未知文件、执行命令）。

---

## 相关源码

- `src/utils/attachments.ts` — Attachment 类型定义、getAttachments()、normalizeAttachmentForAPI()
- `src/utils/messages.ts` — normalizeAttachmentForAPI()、mergeUserMessages()、smooshSystemReminderSiblings()
- `src/types/message.ts` — AttachmentMessage 类型
