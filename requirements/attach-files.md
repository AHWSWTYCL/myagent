# TUI 文件附件功能

> 状态：DRAFT | 作者：analyst agent | 日期：2025-07-16

## 1. 背景与动机

myagent 是一个基于 Anthropic Claude API 的终端 AI 助手（TUI）。用户在日常使用中，经常需要向 LLM 提供上下文文件（如代码文件、截图、PDF 文档等），以便模型能基于具体内容给出更精准的回答或操作。

当前用户只能通过复制粘贴文本来传递信息，这在以下场景中效率低下：
- 引用项目中的代码文件（`.ts`, `.py`, `.md` 等）—— 手动复制麻烦且容易遗漏上下文
- 发送截图或 UI 设计稿 —— 文本方式完全不可行
- 发送 PDF 文档（需求文档、报告等）—— 无法让模型直接读取

因此，需要在 TUI 中提供一种轻量的文件引用机制，让用户能以最小心智负担将本地文件作为附件发送给 LLM。

## 2. 目标用户与典型场景

- **角色：开发者**，在 myagent TUI 中与 Claude 对话
  - **场景 A**：编写/调试代码时，用 `@src/utils/attachments.ts` 引用某文件，让模型分析或修改其中的代码
  - **场景 B**：查看 UI 设计稿时，用 `@screenshots/mockup.png` 发送截图，让模型给出前端实现建议
  - **场景 C**：审阅需求文档时，用 `@docs/requirements.pdf` 发送 PDF，让模型总结或提取关键信息
  - **场景 D**：同时引用多个文件，如 `@file1.ts @file2.ts`，让模型对比它们之间的差异

## 3. 核心目标（In Scope）

1. **@ 语法引用文件**：用户在输入框中以 `@path/to/file` 语法引用本地文件，系统自动解析并附加到消息中发送给 LLM
2. **自动类型检测与编码**：根据文件扩展名自动识别类型（图片 / PDF / 文本），读取内容并 base64 编码
3. **构建 Anthropic Content Blocks**：将附件转换为 API 所需的内容块格式发送
4. **20MB 文件大小上限**：超过上限的文件拒绝附加并提示用户
5. **文件不存在时保留 @ 原文**：引用的文件不存在时，保留 `@path` 原文，避免静默丢失信息
6. **错误可视化提示**：在输入框上方以 ⚠ 指示器显示解析错误（文件不存在、太大、类型不支持）
7. **附件指示器**：成功解析的附件在输入框上方以 📎 列表展示文件名和类型
8. **路径解析**：支持相对路径（基于 `cwd`）和 `~` 家目录展开

## 4. 不做（Out of Scope）

- ❌ 不支持拖拽上传文件（终端环境限制）
- ❌ 不支持粘贴图片/文件（终端环境限制，ink-text-input 不支持 clipboard API）
- ❌ 不支持文件选择器对话框
- ❌ 不支持终端内附件预览（如图片 ASCII 艺术化、缩略图等）
- ❌ 不支持附件跨 session 持久化（消息历史中仅保留显示文本，不保留 base64 数据）
- ❌ 不支持文件夹整体上传
- ❌ 不支持 URL 引用（仅限本地文件系统路径）
- ❌ 不支持非文件系统路径（如未挂载的远程路径）

## 5. 验收标准 AC

每条 AC 用 Given/When/Then 描述，可观察、可验证、不依赖实现细节。

### AC1：单文件引用成功
- **Given** 用户在当前目录下存在 `src/utils/attachments.ts` 文件
- **When** 用户在输入框中输入 `帮我分析一下 @src/utils/attachments.ts 这个文件` 并提交
- **Then** 系统应将文本（清理 @ref 后）和该文件的 base64 编码内容作为 `ContentBlockParam[]` 发送给 LLM

### AC2：图片文件作为 ImageBlockParam 发送
- **Given** 用户存在 `screenshot.png` 文件（< 20MB）
- **When** 用户输入 `@screenshot.png` 并提交
- **Then** 系统应构造一个 `type: 'image'` 的 content block，source 为 `base64`，media_type 为 `image/png`

### AC3：PDF 文件作为 DocumentBlockParam 发送
- **Given** 用户存在 `report.pdf` 文件（< 20MB）
- **When** 用户输入 `总结一下 @report.pdf` 并提交
- **Then** 系统应构造一个 `type: 'document'` 的 content block，并携带文件名作为 title

### AC4：文本文件作为 file path XML 标签发送
- **Given** 用户存在 `example.py` 文件（< 20MB）
- **When** 用户输入 `检查 @example.py 的语法` 并提交
- **Then** 系统应以 `<file path="example.py">\n...文件内容...\n</file>` 格式包裹文本发送

### AC5：文件不存在时保留 @ 原文 + 显示错误
- **Given** 用户引用了不存在的文件 `@nonexistent.ts`
- **When** 用户提交
- **Then** `@nonexistent.ts` 保留在清理后的文本中，同时输入框上方显示 ⚠ 错误提示，消息历史中追加一条 system 消息 `[⚠ file not found]`
- **背景**：反例追问确认 —— 如果用户拼错了路径，系统不会静默丢掉路径文本

### AC6：超过 20MB 的文件被拒绝
- **Given** 用户引用了一个 25MB 的文件 `@large_video.mp4`
- **When** 用户提交
- **Then** 文件不被附加，输入框上方显示 ⚠ "file too large" 错误，原始 `@large_video.mp4` 保留在文本中

### AC7：多个文件引用同时生效
- **Given** 用户存在 `a.ts` 和 `b.png` 两个文件
- **When** 用户输入 `对比 @a.ts 和 @b.png`
- **Then** 系统应同时处理两个文件，各自构造相应类型的 content block，按 @ 出现的顺序依次添加（文本 block 在前，附件 block 在后）

### AC8：@ 语法 + 纯文本混合
- **Given** 用户输入 `看图 @diagram.png 并解释`
- **When** 提交
- **Then** 系统的第一个 content block 应为 text block 包含 "看图  并解释"（@ref 被移除，保留前后空格），随后是 image block

### AC9：不包含 @ 的普通输入不受影响
- **Given** 用户输入 `什么是依赖注入？`
- **When** 提交
- **Then** 系统行为与无附件功能时完全一致，`runTurn` 接收的参数为 `string` 类型

### AC10：附件解析在提交时实时执行（非预缓存）
- **Given** 用户输入 `@file.ts` 后修改了该文件内容
- **When** 用户在修改后提交
- **Then** 系统读取的是提交时刻的文件最新内容

## 6. 输入 / 输出契约

### 6.1 @ 语法格式

```
@<文件路径>
```

- 路径可以是相对路径（相对于 `process.cwd()`）或绝对路径
- 支持 `~` 展开（`@~/Documents/file.pdf` → 展开为家目录路径）
- 路径中可包含空格（但终端输入体验不佳，不推荐）
- 多个文件之间用空格分隔：`@a.ts @b.png @c.pdf`

### 6.2 文件类型映射

| 扩展名 | 类别 | API Content Block 类型 | media_type |
|--------|------|------------------------|------------|
| `.png` | 图片 | `image` | `image/png` |
| `.jpg`, `.jpeg` | 图片 | `image` | `image/jpeg` |
| `.gif` | 图片 | `image` | `image/gif` |
| `.webp` | 图片 | `image` | `image/webp` |
| `.pdf` | 文档 | `document` | `application/pdf` |
| `.txt`, `.md`, `.ts`, `.js`, `.tsx`, `.jsx`, `.json`, `.yaml`, `.yml`, `.toml`, `.sh`, `.bash`, `.css`, `.html`, `.xml`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.sql`, `.graphql`, `.proto`, `.cfg`, `.ini`, `.env`, `.csv`, `.log` | 文本 | `text` | `text/plain` |
| 其他未知扩展名 | 尝试以文本读取 | `text` | `text/plain` |

### 6.3 输出格式（Anthropic Content Block 构造）

**纯文本输入（无附件）：**
```typescript
// 直接以 string 形式传递给 runTurn
"用户输入的文本"
```

**有附件时：**
```typescript
[
  { type: 'text', text: '清理后的用户文本（不含 @ 引用）' },
  // 按 @ 出现顺序附加
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '<base64>' } },
  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: '<base64>' }, title: '文件名', context: '清理后的用户文本' },
  { type: 'text', text: '<file path="example.ts">\n...文件内容...\n</file>' },
]
```

### 6.4 构造规则细节

- 图片附件 → `ImageBlockParam`（`type: 'image'`）
- PDF 附件 → `DocumentBlockParam`（`type: 'document'`），title 为文件名，context 为用户文本（非空时）
- 文本附件 → `TextBlockParam`（`type: 'text'`），内容被包裹在 `<file path="...">\n...\n</file>` XML 标签中

## 7. 边界 Case 与失败处理

| 场景 | 行为 |
|------|------|
| **文件不存在** | `@` 原文保留在清理文本中，不清除也不静默丢弃；在 UI 上显示 ⚠ 错误；消息历史追加 system 消息 `[⚠ file not found]` |
| **超过 20MB** | 同文件不存在处理：保留 `@` 原文，显示 ⚠ "file too large" 错误，文件不被附加 |
| **引用的是目录** | `stat.isFile()` 检查失败，按文件不存在处理 |
| **不支持的格式** | 先尝试以文本方式读取（兜底策略），如果失败则按文件不存在处理 |
| **同时引用多个文件（部分成功部分失败）** | 成功的正常附加，失败的逐个显示 ⚠ 错误；成功附件的 content block 正常构造 |
| **用户提交空文本 + 纯附件** | `displayText` 显示为 `[attachments: 📎 file.png (image)]`，实际发送的 text block 内容为空字符串 |
| **用户输入以 `/` 或 `!` 开头** | 不触发附件解析（命令模式），直接跳过 `parseAttachments` |
| **解析过程中发生异常** | `parseAttachments` 内部 try-catch，静默忽略异常，不阻塞提交 |
| **用户在附件解析期间提交** | 提交时重新解析一次（确保读取最新文件状态），不以防抖中的中间状态为准 |
| **重复附件（同一文件被引用两次）** | 目前不做去重，同一个文件会被读取两次、发送两个 content block（可接受的行为，后续如需优化可加） |
| **并发提交** | agent.ts 的 `runTurn` 内置串行化（`while (agentRunning) await sleep(200)`），不会出现并发冲突 |
| **用户中途 Ctrl+C 取消** | `abortController.abort()` 会中断 API 流；文件读取已完成的部分不回收，但不会发送到 API |

## 8. 与现有系统的关系

### 8.1 文件职责

| 文件 | 职责 |
|------|------|
| `src/utils/attachments.ts` | **核心解析引擎**：`parseAttachments()` 解析 `@` 语法、读取文件、base64 编码；`readFileAsAttachment()` 按扩展名分类处理；`buildUserContent()` 将文本 + 附件组合为 Anthropic content blocks |
| `src/tui/App.tsx` | **UI 集成层**：管理附件状态（`attachments`、`attachmentErrors`）；200ms 防抖调用 `parseAttachments()` 实时解析；显示 📎 附件指示器和 ⚠ 错误提示；在 `handleSubmit()` 中调用 `buildUserContent()` 构造最终输入 |
| `src/agent.ts` | **消息接收层**：`runTurn()` 的签名已支持 `string \| Array<ContentBlockParam>`；将用户内容 push 到 `messages[]` 并送入 `runAgentLoopStream()` |

### 8.2 复用

- 复用 Anthropic SDK 的类型系统（`ContentBlockParam`, `MessageParam` 等）
- 复用 `client.messages.stream()` 的既有 API 调用路径

### 8.3 绝对不动

- 不动 `runAgentLoopStream()` 的核心循环逻辑
- 不动工具注册系统 (`ToolRegistrar`)
- 不动 `compactMessages()` / `microcompactMessages()` 的消息压缩逻辑（附件已编码为 base64 后作为消息内容发送，压缩时只影响 token 估算，不影响附件格式）

## 9. 非功能约束

| 约束 | 值 |
|------|-----|
| **文件大小上限** | 20 MB（单文件） |
| **附件数量限制** | 无显式限制，受 20MB 上限和 API 总消息体大小隐式约束 |
| **解析防抖** | 200ms（只在用户停止输入后才解析，避免频繁 I/O） |
| **路径解析基准** | 相对路径基于 `process.cwd()`，绝对路径保持不变，`~` 展开为用户家目录 |
| **跨 session 持久化** | 不持久化附件 base64 数据，仅在当前 session 的内存 messages 中保留 |
| **消息历史中的附件** | 仅保留显示文本（含 📎 标记），base64 数据不保留 |
| **压缩兼容性** | `compactMessages()` 压缩的是消息数组，附件已编码为 content block，压缩时作为普通消息文本处理，不会破坏附件格式 |
| **可观察性** | 附件解析错误通过 UI 指示器暴露给用户；`console.log` 输出 key 事件供调试 |

## 10. 假设与未决问题

### 已确认的假设（基于用户回答）

1. 附件功能仅通过 `@` 语法实现，不增加拖拽/粘贴/文件选择器等交互方式
2. 不提供终端内预览（图片 ASCII 化、缩略图等）
3. 附件数据不跨 session 持久化，发送后即丢弃 base64
4. 无显式的附件数量上限，由 20MB 总大小隐式约束
5. 文本附件使用 `<file path="...">` XML 标签格式
6. 错误提示（⚠ 黄色指示器 + 保留 @ 原文 + system 消息）作为当前行为已足够
7. 路径解析细节（相对路径/cwd/家目录展开）需要在文档中明确记录

### 未决问题

- 暂无。
