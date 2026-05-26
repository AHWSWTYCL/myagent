# project_builder：项目环境搭建与构建 sub-agent

> 状态：DRAFT | 作者：analyst agent | 日期：2025-07-17

## 1. 背景与动机

现有的 sub-agent 流水线中：
- **explore** 做只读代码调研，不修改任何文件
- **generator** 负责按计划写入代码
- **debug_expert** 负责运行时 bug 诊断
- **verifier** 做修复合规性验证

但缺少一个专门负责「**让项目跑起来**」的环节。当 coordinator 需要：
> "这是一个新拉下来的项目，帮我搭好环境、编译通过，再验证产物能不能正常启动"

或
> "代码改完了，重新构建一下，确认构建产物没问题"

时，没有一个 agent 能一站式完成「检测依赖 → 安装项目依赖 → 构建 → 诊断修复构建错误 → 验证产物」这套流程。project_builder 填补的就是这个缺口。

它消费调用方传的任务描述（和可选的项目路径），在项目目录中自动完成环境检测、依赖安装、构建执行、错误诊断与修复、产物验证，最后返回结构化报告给调用方。

## 2. 目标用户与典型场景

- **角色 A：coordinator agent** — 在代码流水线中调用 project_builder。典型会话：
  1. coordinator 接到用户需求「搭好环境跑起来」
  2. 调用 `agent(agent="project_builder", task="搭建环境并构建项目")`
  3. project_builder 自动检测项目类型 → 装依赖 → 构建 → 验证 → 返回报告
  4. coordinator 根据报告决定下一步（如继续开发 or 转给 debug_expert）

- **角色 B：human user（间接）** — 用户在对话中说「帮我 build 一下这个项目」，coordinator 派 project_builder 执行；在构建遇到无法自动修复的错误时，project_builder 通过 ask_user 向用户求助。

## 3. 核心目标（In Scope）

1. **自动检测项目类型** — 根据项目根目录的构建描述文件自动识别项目类型，无需调用方显式指定语言/构建系统。
2. **环境搭建 — 检测与安装依赖** — 检测项目所需依赖（工具链 + 项目级包依赖）的完整性；自动安装项目级包依赖（npm install、pip install、go mod download 等）；检测到系统级工具链缺失时，报告缺失项并提示用户手动安装，不自动安装。
3. **构建/编译 — 执行与诊断修复** — 运行对应项目的构建命令；构建失败时进行系统性诊断，定位根因并尝试自动修复（从缺失依赖到构建配置到代码层面的问题均可尝试）；修复遇到瓶颈（超过约 10 轮仍无法解决）时，输出已排查路径和未解决问题，停止尝试并交回给调用方。
4. **构建产物验证** — 构建成功后，启动产物（二进制/脚本/服务），等待若干秒确认未崩溃后 kill 掉；返回启动状态和日志片段。
5. **构建期错误与运行期 bug 的边界** — project_builder 只负责构建阶段的错误诊断修复；构建成功但产物运行时出现行为异常，转给 debug_expert。

## 4. 不做（Out of Scope）

- ❌ **不涉及部署** — 不上传服务器、不推生产环境、不配置容器编排
- ❌ **不配置 CI/CD** — 不写 .github/workflows、不配置 Jenkinsfile、不设置自动化流水线
- ❌ **不配置 IDE** — 不生成 .vscode/*、不装 IDE 插件、不设置 editorconfig
- ❌ **不涉及 Docker** — 不构建 Docker 镜像、不写 Dockerfile、不配置 docker-compose
- ❌ **不做代码 lint/格式化** — 不跑 linter、不格式化代码（这是 code review skill 的职责）
- ❌ **不做项目初始化** — 不执行 cargo init / npm init / git init 等初始化操作
- ❌ **不做运行时 bug 诊断** — 构建成功后产物运行时的行为异常，转给 debug_expert

## 5. 验收标准（AC）

**AC1：自动检测项目类型并选择正确的构建策略**
- **Given** 一个包含 `Cargo.toml`（无其他构建文件）的项目目录
- **When** project_builder 被调用
- **Then** 它应识别为 Rust 项目，使用 `cargo check` → `cargo build` 流程
- **反例**：同时存在 `Cargo.toml` + `Makefile` 时，以更具体的 `Cargo.toml` 为准（Rust 项目），而非降级为通用 make。

**AC2：检测依赖完整性并自动安装项目级依赖**
- **Given** 一个 Node.js 项目，`node_modules/` 不存在
- **When** project_builder 检测到 package.json 但依赖未安装
- **Then** 自动执行 `npm install`（或 `yarn install` / `pnpm install`，取决于 lockfile），安装完成后进入构建阶段
- **反例 1**：系统没有安装 Node.js。project_builder 应检测到并报错：`Error: Node.js 未安装，请手动安装 (https://nodejs.org)`，不自动安装。
- **反例 2**：npm install 因为网络问题失败。应捕获错误信息返回给调用方，不静默忽略。

**AC3：构建失败时进行系统性诊断并尝试修复**
- **Given** 一个 C++ 项目，cmake 构建失败，报 `undefined reference to 'curl_global_init'`
- **When** project_builder 检测到链接错误与 libcurl 相关
- **Then** 应尝试检查是否安装了 libcurl-dev，如缺失则尝试安装（apt-get install libcurl4-openssl-dev），然后重新构建
- **反例**：构建失败但报错信息模糊（如 `internal compiler error`），无法归因。应在报告中如实反映，尝试用更简单的编译参数重试，如果仍失败则输出已尝试的排查步骤。

**AC4：修复遇到瓶颈时及时停止并报告**
- **Given** project_builder 在诊断构建错误，经过多轮尝试（约 10 轮）仍未解决
- **When** 已用尽可尝试的修复路径
- **Then** 应停止尝试，输出包含「已排查的根因假设」「已尝试的修复方法」「未解决的问题」的结构化报告，交给调用方处理，不无限循环
- **反例**：agent 在修一个复杂错误时每次只尝试一种方案，若全部尝试后仍失败才停止，而不是只试两次就放弃。

**AC5：构建成功后验证产物能正常运行**
- **Given** project_builder 已完成构建，产出一个可执行文件
- **When** 对生成物运行验证
- **Then** 应启动该可执行文件，等待 5 秒确认未崩溃/未异常退出，然后 kill 进程（SIGTERM → 等待 2 秒 → SIGKILL），返回启动状态和 stdout/stderr 片段
- **反例 1**：产物是一个 CLI 工具（立即执行完毕后退出的类型），应在验证时传 `--version` 或类似参数确认退出码为 0，而非启动后 kill
- **反例 2**：产物是一个 HTTP 服务，监听端口后不退出。应根据项目类型判断：如有已知端口则尝试 `curl localhost:<port>` 确认服务响应，否则仅观察进程是否崩溃

**AC6：输入校验与错误处理**
- **Given** project_builder 被调用时，传入的 `project_path` 指向不存在的目录
- **When** 检测到路径无效
- **Then** 应返回 `Error: 项目路径 "xxx" 不存在`，不继续构建
- **反例**：`project_path` 未传，应使用当前工作目录，而非报错

**AC7：构建构建期 vs 运行期 bug 的职责边界**
- **Given** project_builder 完成了构建和产物验证（产物启动正常），但用户反馈运行后出现业务逻辑错误
- **When** 调用方要求处理该运行时异常
- **Then** project_builder 应拒绝运行时的 bug 诊断，建议转调 debug_expert agent
- **反例**：项目能编译但运行时有段错误（SIGSEGV）。project_builder 应告知「构建已成功，运行时问题超出我的职责范围，建议调用 debug_expert」

**AC8：无构建文件的空项目处理**
- **Given** 项目目录中没有任何常见的构建描述文件（CMakeLists.txt、Cargo.toml、go.mod、package.json、Makefile、pom.xml、build.gradle、pyproject.toml、requirements.txt 等）
- **When** project_builder 尝试检测项目类型
- **Then** 应返回错误：`Error: 无法自动检测项目类型，未找到已知的构建描述文件。请手动指定项目类型或添加构建文件。`，并列出已查找的文件类型清单
- **反例**：目录下有一个 `README.md` 和一个 `src/main.c` 但没有 Makefile 或 CMakeLists.txt → 也应该报错无法检测，而不是假设为纯 gcc 项目直接编译

## 6. 输入 / 输出契约

### 输入（inputSchema）

```json
{
  "properties": {
    "task": {
      "type": "string",
      "description": "任务描述，如「搭建环境并构建项目」或「重新构建并验证」"
    },
    "project_path": {
      "type": "string",
      "description": "项目根目录路径（可选）。未传时使用当前工作目录"
    }
  },
  "required": ["task"]
}
```

### 输出

纯文本字符串，通过 agent runner 的 `lastText` 返回给调用方。文本结构如下：

```
## 项目类型
（检测到的项目类型：Rust / C++ / Go / Node.js / Python / Java / Makefile / 未知）

## 环境检测
（检测了哪些工具链和依赖、哪些已满足、哪些缺失、自动安装了哪些）

## 构建过程
（执行的构建命令、输出摘要、是否成功）

## 构建诊断（如有）
（构建失败时的排查过程、根因分析、尝试的修复方法）

## 产物验证
（验证方式、结果、日志片段）

## 未解决的问题（如有）
（未能自动修复的问题、已排查的假设、留给调用方的建议）
```

### 工具列表

| 工具名 | 用途 | 备注 |
|--------|------|------|
| `read_file` | 读取构建文件/源码/配置 | 核心工具 |
| `write_file` | 写中间分析文件、修复配置 | 构建修复时使用 |
| `list_dir` | 列出项目目录结构 | 检测阶段 |
| `bash` | 执行构建命令、安装依赖、启动产物 | **完整权限**（含写入），是核心执行工具 |
| `grep` | 搜索源码/构建日志中的错误模式 | 诊断阶段核心工具 |
| `glob` | 文件模式匹配 | 辅助定位产物路径 |
| `ask_user` | 向用户追问线索 | 构建修复遇到瓶颈时 |
| `ask_user_choice` | 向用户提供选项 | 构建修复遇到瓶颈时 |

## 7. 边界 Case 与失败处理

| 场景 | 处理方式 |
|------|----------|
| **项目路径不存在** | 返回 `Error: 项目路径 "xxx" 不存在` |
| **项目路径未传** | 使用当前工作目录（process.cwd()） |
| **当前工作目录也不可访问** | 返回 `Error: 当前工作目录不可访问` |
| **无已知构建描述文件** | 返回错误，列出已查找的文件类型清单 |
| **有多个构建文件时如何选** | 按优先级：Cargo.toml > go.mod > package.json > pom.xml/build.gradle > pyproject.toml/requirements.txt > CMakeLists.txt > Makefile。更具体的优先于通用 make |
| **系统工具链缺失** | 检测到缺失（如无 gcc、rustc、go、node 等），报告缺失并附安装指引，不自动安装 |
| **项目级依赖安装失败** | 捕获错误输出，尝试分析根因（网络问题？版本冲突？权限？）并返回 |
| **构建命令自身不存在** | 如 `cargo` 不在 PATH 中，报错提示工具链未安装 |
| **构建超时** | 默认 5 分钟超时（通过 bash 的 timeout 命令包装），超时后 kill 进程，返回已产生的部分输出 |
| **构建输出过长** | 对 stdout/stderr 截断到最后 200 行，并在报告中标注「输出已截断，完整日志见 xxx」 |
| **构建过程消耗过多资源** | 不作限制（假设用户知道自己在做什么）；若导致 myagent 本身 OOM，由系统级行为处理 |
| **产物验证时进程 hang 住** | wait 5 秒后 SIGTERM，再 2 秒后 SIGKILL，返回 hang 前的输出片段 |
| **产物是图形程序（无终端）** | 检测到无法在无头环境运行（如需要 DISPLAY），跳过启动验证，返回「图形程序，无法在当前环境验证」 |
| **用户中途取消（Ctrl+C）** | 通过 AbortSignal 传递取消信号，agent 终止当前 bash 进程；不清理已安装的依赖（假设为假设） |
| **并发调用** | coordinator 应避免同时触发两个 project_builder 实例操作同一项目目录；v1 不实现锁机制 |
| **项目目录是 git 子模块/只读** | bash 执行写操作失败时捕获错误，报告权限问题，不继续 |
| **构建在 Docker 环境中** | 保持对纯 bash 的依赖，不假设 Docker 存在；运行 bash 命令时按标准流程走 |

## 8. 与现有系统的关系

### 复用

- **AgentDefinition 接口** — 复用现有 `definition.ts` 的 `AgentDefinition`、`AgentInputSchema`、`AgentRunContext` 类型
- **AgentRegistry** — 通过 `registry.register()` 注册，复用现有发现机制
- **工具系统** — 复用 read_file、write_file、list_dir、bash、grep、glob、ask_user、ask_user_choice 等工具
- **runner.ts** — 复用 `runAgent()` 执行逻辑，包括 systemPrompt 异步求值、formatUserMessage、extraTools 工厂、finalize 钩子
- **agent tool** — 复用 `AgentTool` 作为调度入口，LLM 通过 `agent(agent="project_builder", task=..., project_path=...)` 调用

### 改写

- **src/agents/builtin/index.ts** — 新增 `import { projectBuilderAgent } from './project_builder.js'` 并加入 `builtinAgents` 数组
- 无其他需要改写的现有代码

### 绝对不动

- ❌ 不动 **debug_expert 的职责边界** — project_builder 只处理构建期错误，运行期 bug 归 debug_expert
- ❌ 不动 **explore 的只读边界** — explore 产出代码结构报告，不因 project_builder 的存在而修改
- ❌ 不动 **generator 的职责** — generator 负责实施代码级改动，project_builder 的「修复代码」场景仅限构建相关的修补（如补 #include、调整 CMakeLists.txt），不做业务逻辑改动
- ❌ 不动 **coordinator 的调度逻辑** — 不修改 coordinator 的流水线编排代码

## 9. 非功能约束

| 维度 | 约束 |
|------|------|
| **maxTurns** | 20 轮（与 general-purpose 一致） |
| **模型** | 使用默认模型（当前为 claude-sonnet-4-6） |
| **输出可见度** | 文本返回给调用方；不落盘为文件 |
| **持久化** | 不做跨 session 持久化；每次调用独立执行 |
| **bash 超时** | 构建命令默认 5 分钟超时（通过 `timeout 300` 包装） |
| **产物验证等待** | 启动产物后等待 5 秒确认未崩溃，然后 SIGTERM → 2 秒 → SIGKILL |
| **可观察性** | project_builder 的排查过程通过 emitLine 输出（带 `[project_builder]` 前缀），调用方可观察中间步骤 |
| **安装残留** | 自动安装的依赖（node_modules/、vendor/、build/ 等目录）不主动清理；若构建失败，已安装的依赖可能残留，视为正常行为 |
| **环境变更** | project_builder 可能会修改项目目录（安装依赖、创建构建输出等），调用方应知悉 |

## 10. 假设与未决问题

### 假设

1. **项目根目录有明显结构** — 构建描述文件位于根目录下；没有描述文件时返回无法检测
2. **bash 环境完整** — project_builder 假设 bash 可用，且 curl/wget/apt-get/pip/npm 等包管理器可按需调用
3. **并发不会发生** — v1 假设同一时间只有一个 project_builder 实例在操作一个项目目录
4. **构建失败可诊断** — 多数构建错误有明确的错误信息和行号，agent 能据此推断根因
5. **网络可达** — 安装项目依赖时需要网络连接；网络不可达时依赖安装失败，agent 返回错误信息
6. **产物验证安全** — 启动的构建产物不会对系统造成破坏（不格式化磁盘、不删除文件）；用户应确保构建产物的安全性

### 未决问题

1. **项目类型优先级规则** — 当检测到多个构建文件时，目前的优先级是 Cargo.toml > go.mod > package.json > pom.xml > requirements.txt > CMakeLists.txt > Makefile。这个排序是否合理？是否需要让调用方可配置？
2. **构建输出去重/压缩阈值** — 200 行截断阈值是假设值，实际是否需要调整？
3. **并行构建支持** — 是否需要在 v1 就支持多个目录/项目的并行构建？目前只支持串行。
4. **与 verifier agent 的关系** — verifier 负责「代码修改是否符合 AC」，project_builder 负责「能否构建运行」。两者可能在「改完代码后重新构建」的场景上有重叠，是否需要 coordinator 协调？
5. **系统工具链安装的自动化** — 目前策略是检测到缺失时报错。未来是否允许通过 `--auto-install-toolchains` 标志启用自动安装？留给后续版本决策。
