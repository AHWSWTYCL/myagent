# MCP (Model Context Protocol) 支持

> 状态：DRAFT | 作者：analyst agent | 日期：2025-07-16

## 1. 背景与动机

myagent 当前的工具系统基于 `Tool` 基类注册到 `ToolRegistrar`，工具集是硬编码在 `agent.ts` 里的。这意味着：
- 用户无法接入第三方工具生态（如文件系统操作、数据库查询、API 调用、代码分析等）
- 每次新增工具都需要修改 myagent 源码并重新部署
- 无法复用日益增长的 MCP 生态工具

MCP (Model Context Protocol) 是 Anthropic 提出的开放协议，它标准化了 AI 应用连接外部工具和数据源的方式。让 myagent 支持 MCP，相当于给 agent 打开了一个"工具应用商店"——用户只需写几行配置，就能挂载任意的 MCP Server 暴露的能力。

## 2. 目标用户与典型场景

- **角色：开发者**，使用 myagent TUI 与 AI 对话
  - **场景 A**：连接文件系统 MCP Server，让 agent 直接读写项目目录（跨越 `read_file`/`write_file` 的路径限制）
  - **场景 B**：连接数据库 MCP Server（如 `mcp-server-postgres`），让 agent 直接查询数据库并返回结果
  - **场景 C**：连接第三方 API MCP Server（如 GitHub、Slack、Jira），让 agent 操作外部服务
  - **场景 D**：连接自定义内网 MCP Server（SSE 传输），让 agent 访问公司内部的数据或工具
  - **场景 E**：通过 `!mcp list` 查看当前连接了哪些 MCP Server 及其暴露的工具/资源/提示

## 3. 核心目标（In Scope）

1. **配置加载**：从 `~/.myagent/mcp-servers.json` 读取 MCP Server 配置列表，格式兼容 Claude Code 规范
2. **Transport 支持**：同时支持 **stdio**（子进程 stdin/stdout）和 **SSE**（HTTP 长连接）两种传输方式
3. **生命周期管理**：agent 启动时[预连接]所有配置的 MCP Server；agent 退出时优雅关闭（kill 子进程 / 断开 SSE）
4. **MCP Tools 映射**：MCP Server 暴露的 tools 自动包装为 `Tool` 子类实例，注册到 `ToolRegistrar`，LLM 可以像使用本地工具一样调用
5. **MCP Resources 映射**：MCP Server 暴露的 resources 包装为只读工具（`{server}__resource__{name}`），LLM 通过工具调用按需读取
6. **MCP Prompts 映射**：MCP Server 暴露的 prompts 包装为工具（`{server}__prompt__{name}`），LLM 调用时传入参数获取渲染后的 prompt 文本
7. **命名冲突**：MCP 工具名与本地工具冲突时，**本地工具优先**，MCP 工具跳过注册并打警告日志
8. **权限控制**：MCP 工具的调用走既有 `PermissionHook` 体系（黑/白名单配置 + session 缓存 + auto-agent 决策）
9. **故障隔离**：某个 MCP Server 连接失败或运行中崩溃时，仅标记该 Server 为 disconnected，将其工具从列表中移除，不影响其他功能和本地工具
10. **TUI 可见性**：在 TUI 中显示 MCP 连接状态，提供 `!mcp` 命令（`list` / `status` / `reconnect` / `disconnect`）
11. **MCP 客户端协议实现**：在 myagent 内部实现 MCP Client 侧协议（初始化、工具列表获取、工具调用、资源读取、提示获取）

## 4. 不做（Out of Scope）

- ❌ 不支持 MCP Server 的热加载（启动后修改配置文件需要重启 myagent 才能生效）
- ❌ 不支持通过 MCP Resources 自动注入 system prompt（Resources 统一暴露为只读工具，不自动预读内容）
- ❌ 不支持 MCP Prompts 自动替换 system prompt（Prompts 作为工具按需调用）
- ❌ 不支持 MCP Server 的负载均衡或高可用
- ❌ 不支持 MCP Transport 的自定义协议扩展（仅标准 stdio 和 SSE）
- ❌ 不做跨 session 的 MCP 连接状态持久化（每次启动重新连接）
- ❌ 不做 MCP Server 配置的 UI 编辑界面（仅通过编辑 JSON 文件配置）

## 5. 验收标准 AC

### AC1：从配置文件加载并预连接 MCP Server
- **Given** `~/.myagent/mcp-servers.json` 中存在一个有效的 stdio MCP Server 配置（如 `filesystem` 使用 `npx -y @modelcontextprotocol/server-filesystem`）
- **When** myagent 启动完成
- **Then** 该 MCP Server 的子进程已启动且成功握手（`initialize` + `tools/list` + `resources/list` + `prompts/list` 已完成），其工具已出现在 `ToolRegistrar.getAllTools()` 返回的列表中
- **反例追问确认**：如果配置了 3 个 Server，其中 2 个成功、1 个失败（如命令不存在），应跳过失败的 Server，注册成功的 2 个，并在日志中打印失败原因

### AC2：LLM 调用 MCP Tool 成功
- **Given** MCP Server `filesystem` 已连接，暴露了 `read_file` 工具
- **When** LLM 调用 `filesystem__read_file` 工具（参数 `{path: "/etc/hostname"}`）
- **Then** myagent 通过 MCP 协议 `tools/call` 将请求发给子进程，获取结果后返回给 LLM，返回格式与本地工具一致（`string`）
- **反例追问确认**：如果 MCP Server 返回错误（如文件不存在），工具应返回包含错误信息的字符串（如 `Error: File not found: /etc/hostname`），而非抛出未捕获异常

### AC3：MCP Resource 作为只读工具调用
- **Given** MCP Server `database` 暴露了 resource `db://users/schema`
- **When** LLM 调用 `database__resource__users_schema` 工具
- **Then** myagent 通过 MCP 协议 `resources/read` 获取内容并返回给 LLM

### AC4：MCP Prompt 作为工具调用
- **Given** MCP Server `git` 暴露了 prompt `commit-message`，接受参数 `{diff: string}`
- **When** LLM 调用 `git__prompt__commit_message` 工具（参数 `{diff: "..."}`）
- **Then** myagent 通过 MCP 协议 `prompts/get` 获取渲染后的 prompt 文本并返回给 LLM

### AC5：命名冲突时本地工具优先
- **Given** 本地已有 `read_file` 工具，MCP Server `filesystem` 也暴露了名为 `read_file` 的工具
- **When** MCP Server 连接完成，工具注册阶段
- **Then** 本地的 `read_file` 保持不变，MCP 的 `read_file` 不注册，控制台打印 `[mcp] WARN: tool "read_file" from server "filesystem" conflicts with local tool, skipped`
- **反例追问确认**：如果本地没有 `filesystem__read_file` 但 MCP Server 名为 `filesystem` 的工具恰好叫 `filesystem__read_file` 这种带双下划线的名字——采用前缀策略后天然不冲突，正常注册

### AC6：权限控制走 PermissionHook
- **Given** `~/.myagent/permissions.json` 中配置了黑名单规则 `{tool: "filesystem__write_file", pattern: "/etc/**"}`
- **When** LLM 尝试调用 `filesystem__write_file` 写入 `/etc/passwd`
- **Then** PermissionHook 的黑名单检测拦截该调用，返回 `Permission denied: Blocked by blacklist rule`，与本地工具行为一致
- **反例追问确认**：用户通过 session 授权了 `filesystem__read_file`，该授权应在 session 内缓存，后续同参数调用不再弹窗

### AC7：MCP Server 启动失败时优雅跳过
- **Given** `~/.myagent/mcp-servers.json` 中配置了指向不存在的命令的 MCP Server（如 `command: "nonexistent-binary"`）
- **When** agent 启动，尝试启动该 Server
- **Then** 控制台打印 `[mcp] ERROR: failed to connect server "broken": spawn nonexistent-binary ENOENT`，该 Server 标记为 disconnected，不阻塞 agent 启动，其他 Server 正常连接
- **反例追问确认**：如果配置了 3 个 Server，2 个成功 1 个失败，最终 `ToolRegistrar.getAllTools()` 应仅包含成功 Server 的工具。LLM 能正常使用成功 Server 的工具，不会察觉到另一个 Server 的存在

### AC8：运行中 MCP Server 崩溃不影响其他功能
- **Given** 两个 MCP Server（`svc-a`、`svc-b`）均已成功连接
- **When** `svc-a` 的子进程意外退出（exit code 非 0）
- **Then** 控制台打印 `[mcp] ERROR: server "svc-a" process exited with code 1, marking disconnected`；`svc-a` 的所有工具从工具列表中移除；`svc-b` 的工具正常使用；本地工具不受影响
- **反例追问确认**：工具移除后，LLM 下次请求时 tools 数组已不包含已断开的 Server 的工具，LLM 不会尝试调用不存在的工具

### AC9：TUI 显示 MCP 连接状态
- **Given** 已连接 2 个 MCP Server，1 个断开
- **When** 用户在 TUI 中查看状态
- **Then** 状态区域显示 MCP 概览（如 `MCP Servers: 2 connected, 1 disconnected`），`!mcp list` 列出每个 Server 的名称、传输类型、状态、工具数量
- **反例追问确认**：没有配置任何 MCP Server 时，`!mcp list` 显示 `No MCP servers configured`，不报错

### AC10：SSE 模式 MCP Server 正常连接
- **Given** `~/.myagent/mcp-servers.json` 中配置了 SSE 类型的 MCP Server（`url: "http://localhost:8080/sse"`）
- **When** agent 启动
- **Then** myagent 通过 HTTP 连接该 SSE 端点，完成 MCP 握手，工具注册成功
- **反例追问确认**：SSE 连接超时（如目标服务器未启动），应在可配置的超时时间（默认 10 秒）后标记为 disconnected，不打崩 agent

### AC11：支持跨架构的 stdio 命令
- **Given** MCP Server 配置为 `command: "npx", args: ["-y", "some-server"]`
- **When** agent 启动
- **Then** 使用 `child_process.spawn()` 启动子进程，支持任意 shell 命令（不依赖 shell 解析），正确处理 stdout/stderr 分离

### AC12：SSE Server 的工具调用依然走权限检查
- **Given** 一个 SSE MCP Server 暴露了 `delete_user` 工具
- **When** LLM 调用 `server__delete_user` 工具
- **Then** 该调用通过 PermissionHook 的 onToolCall 检查，与 stdio Server 的工具无差别

## 6. 输入 / 输出契约

### 6.1 配置文件格式：`~/.myagent/mcp-servers.json`

完全兼容 Claude Code 的 `mcpServers` 格式：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "env": {
        "NODE_ENV": "production"
      }
    },
    "database": {
      "command": "uvx",
      "args": ["mcp-server-postgres", "--connection-string", "postgresql://..."],
      "env": {}
    },
    "weather": {
      "url": "https://weather-mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

- **stdio Server**：必须包含 `command` 字段，可选 `args` 和 `env`
- **SSE Server**：必须包含 `url` 字段，可选 `headers`
- 不支持的字段（Claude Code 特有但 myagent 忽略）：`disabled`（不做热加载）、`autoStart`（全部预连接）

### 6.2 工具命名规则

| 类型 | 命名格式 | 示例 |
|------|----------|------|
| MCP Tool | `{server_name}__{tool_name}` | `filesystem__read_file` |
| MCP Resource | `{server_name}__resource__{resource_name}` | `database__resource__users_schema` |
| MCP Prompt | `{server_name}__prompt__{prompt_name}` | `git__prompt__commit_message` |

- `{server_name}`：配置中的 key 名，全小写化、空格和下划线替换为 `-`
- `{tool_name}` / `{resource_name}` / `{prompt_name}`：MCP Server 返回的原始名称，保持原样
- `__`（双下划线）作为层级分隔符，约定不与本地工具名冲突（本地工具名使用单下划线或无分隔符）

### 6.3 MCP Tool 包装的 Tool 接口实现

```typescript
class McpToolWrapper extends Tool {
  get name(): string       // → "filesystem__read_file"
  get description(): string // → 来自 MCP 的 description
  get input_schema(): object // → 来自 MCP 的 inputSchema，转换为 Anthropic Tool 格式
  async execute(args): Promise<string>  // → 通过 MCP 协议调用 tools/call
  async checkPermission(args): Promise<ToolPermissionResult> // → 默认 defer，由 PermissionHook 决定
}
```

### 6.4 MCP 客户端协议交互

MCP 协议使用 **JSON-RPC 2.0** 格式。myagent 需实现以下方法：

| 生命周期阶段 | 方法 | 方向 | 说明 |
|-------------|------|------|------|
| 初始化 | `initialize` | Client → Server | 携带协议版本和客户端信息 |
| 初始化 | `initialized` | Client → Server | 通知初始化完成 |
| 初始化 | `tools/list` | Client → Server | 获取工具列表 |
| 初始化 | `resources/list` | Client → Server | 获取资源列表 |
| 初始化 | `prompts/list` | Client → Server | 获取提示列表 |
| 运行时 | `tools/call` | Client → Server | 调用工具 |
| 运行时 | `resources/read` | Client → Server | 读取资源 |
| 运行时 | `prompts/get` | Client → Server | 获取渲染后的提示 |
| 通知 | `notifications/initialized` | Client → Server | 初始化完成通知 |
| 通知 | `notifications/cancelled` | Client → Server | 取消进行中的请求 |

**stdio 传输**：JSON-RPC 消息通过子进程的 stdin/stdout 逐行读写
**SSE 传输**：通过 `POST /message` 发送请求，通过 SSE endpoint 接收响应

### 6.5 错误返回

MCP 工具调用的错误统一以字符串返回（与本地工具一致），格式：

- 调用成功：`MCP Server 返回的 content 文本`
- 工具不存在：`Error: MCP tool "xxx" not found on server "yyy"`
- 服务器断开：`Error: MCP server "yyy" is disconnected`
- 调用超时：`Error: MCP call to "yyy" timed out after 30s`
- 其他协议错误：`Error: MCP error from server "yyy": {error.message}`

## 7. 边界 Case 与失败处理

| 场景 | 行为 |
|------|------|
| **配置文件不存在** | 静默跳过，不报错，不连接任何 MCP Server，不影响正常使用 |
| **配置文件格式错误（JSON 解析失败）** | 控制台打印 `[mcp] ERROR: failed to parse ~/.myagent/mcp-servers.json`，不连接任何 MCP Server |
| **配置中字段缺失** | Server 没有 `command` 也没有 `url` → 跳过该 Server，打印 `[mcp] WARN: server "xxx" has neither command nor url, skipped` |
| **stdio 子进程启动失败** | `spawn` 抛出异常（如命令不存在）→ 标记断开，打印错误，不阻塞 |
| **stdio 子进程启动后握手失败** | `initialize` 无响应或返回错误 → 标记断开，kill 子进程 |
| **stdio 子进程运行中崩溃** | 子进程 exit → 标记断开，工具列表移除 |
| **SSE 连接失败** | `fetch` 报错或超时 → 标记断开 |
| **SSE 连接中途断开** | SSE 连接 error/close 事件 → 标记断开 |
| **初始化阶段 tools/list 返回空列表** | Server 正常连接，但无可用工具（合法状态），TUI 显示 `0 tools` |
| **工具调用超时** | 默认 30 秒超时 → 返回 `Error: MCP call to "yyy" timed out` |
| **单个 Server 中多个工具重名** | MCP Server 自身不应返回重名工具；如果发生，取最后一个，打印警告 |
| **所有 MCP Server 都失败** | 所有 Server 标记断开，本地工具正常使用，TUI 显示 `0 connected` |
| **没有配置任何 MCP Server** | 正常启动，TUI 不显示 MCP 面板区域（或显示「No MCP servers」） |
| **用户在中途中断（Ctrl+C）** | `process.on('SIGINT')` 或 agent 退出时，遍历所有 stdio Server kill 子进程，SSE 连接关闭 |
| **工具调用中 Server 崩溃** | LLM 等到的结果是 `Error: MCP server "yyy" disconnected during call`，该工具后续不再出现在工具列表中 |
| **并发调用同一个 MCP Server 的不同工具** | 通过单一连接串行化 JSON-RPC 请求，使用 request ID 匹配响应，避免并发冲突 |
| **MCP Server 返回非标准 JSON-RPC 错误** | 解析失败时回退为 `Error: MCP error from server "yyy": <原始响应文本的前 200 字>` |
| **SSE Server 的 url 指向非 SSE 端点** | 连接后无法建立 SSE 流（无 `data:` 消息），超时后标记断开 |

## 8. 与现有系统的关系

### 8.1 复用

| 组件 | 复用方式 |
|------|----------|
| `Tool` 基类 | MCP Tools/Resources/Prompts 都包装为 `Tool` 子类，复用 `name` / `description` / `input_schema` / `execute()` / `checkPermission()` 接口 |
| `ToolRegistrar` | MCP 工具注册到 `ToolRegistrar`，通过 `getAllTools()` 自动参与工具列表构建 |
| `PermissionHook` | MCP 工具走同一套 `onToolCall` 钩子，复用黑白名单 + session 缓存 + auto-agent |
| `runAgentLoopStream` | 无改动——`ToolRegistrar` 输出的 `Anthropic.Tool[]` 已包含 MCP 工具，LLM 自动知晓 |
| `executeTool()` 函数 | MCP 工具调用也走 `toolRegistrar.getTool(name)?.execute(args)` 路径 |
| `withRetry` 客户端重试 | 复用 `client.ts` 中的指数退避重试逻辑（用于 SSE HTTP 请求） |
| `TuiBridge` | 复用消息/状态推送通道来展示 MCP 连接状态信息 |

### 8.2 新增

| 文件 | 职责 |
|------|------|
| `src/mcp/mcpmanager.ts` | MCP 管理器：加载配置、管理 Server 生命周期（连接/断开/重启）、提供状态查询 |
| `src/mcp/mcpserver.ts` | 单个 MCP Server 连接：stdio 子进程管理 / SSE 连接管理、JSON-RPC 消息收发 |
| `src/mcp/mcptoolwrapper.ts` | MCP Tool/Resource/Prompt 的 Tool 包装类 |
| `src/mcp/mcptransport.ts` | Transport 抽象（StdioTransport / SSETransport），处理底层 I/O |
| `src/mcp/mcpprotocol.ts` | JSON-RPC 2.0 消息构造/解析，MCP 协议方法封装 |
| `src/commands/mcpcommand.ts` | `!mcp` 命令处理 |
| `src/tui/McpStatusPanel.tsx` | TUI 中 MCP 状态指示组件 |

### 8.3 改写

| 文件 | 改动 |
|------|------|
| `src/agent.ts` | 启动时初始化 `McpManager`，连接 MCP Server，注册工具；退出时 shutdown |
| `src/tui/App.tsx` | 集成 MCP 状态面板 |
| `src/tui/bridge.ts` | 增加 MCP 状态变更的事件类型（可选） |

### 8.4 绝对不动

- ❌ 不动 `runAgentLoopStream()` 的核心循环逻辑
- ❌ 不动现有 `Tool` 子类的实现（`ReadTool`, `BashTool` 等）
- ❌ 不动 `compactMessages()` / `microcompactMessages()` 消息压缩
- ❌ 不动 `PermissionHook` 的决策逻辑（仅注册 MCP 工具时名称带有 `__` 前缀，规则匹配正常）
- ❌ 不动 `AgentRegistry` 和 `AgentTool`

## 9. 非功能约束

| 约束 | 值 |
|------|-----|
| **启动延迟** | MCP Server 连接在 agent 初始化阶段并行执行，不应显著增加启动时间。所有 Server 的握手应在 30 秒内完成，超时的 Server 标记为 disconnected |
| **工具调用超时** | 单个 MCP tool call 默认 30 秒超时（可配置） |
| **SSE 连接超时** | SSE 建立连接的超时时间为 10 秒 |
| **子进程管理** | agent 退出时，必须 SIGTERM → 等待 3 秒 → SIGKILL 所有 stdio 子进程，避免僵尸进程 |
| **内存** | 每个 stdio 子进程占用独立进程空间，不共享内存；SSE 连接保持长连接 |
| **日志** | MCP 连接/断开/错误通过 `console.log` 输出（走 bridge 显示在 TUI 系统消息中），不写独立日志文件 |
| **可观察性** | `!mcp list` 展示每个 Server 的连接状态、传输类型、工具数量；`!mcp status {server}` 显示详细信息 |
| **跨 session** | MCP Server 状态不持久化，每次启动重新连接 |
| **JSON-RPC 请求 ID** | 使用递增整数 ID，支持并发请求的响应匹配 |
| **SSE 重连** | 不做自动重连，断开后需用户 `!mcp reconnect {server}` 手动重连 |

## 10. 假设与未决问题

### 已确认的用户决策

1. ✅ MCP 配置存放在 `~/.myagent/mcp-servers.json`，不与 Claude Code 共用配置文件
2. ✅ 同时支持 stdio 和 SSE 传输
3. ✅ agent 启动时预连接所有 MCP Server
4. ✅ MCP 工具走 `PermissionHook` 统一权限控制
5. ✅ 命名冲突时本地工具优先，MCP 工具跳过
6. ✅ 连接失败或崩溃时只打日志、标记断开、不影响其他功能
7. ✅ 配置格式兼容 Claude Code 规范
8. ✅ Tools、Resources、Prompts 三个能力全部支持
9. ✅ Resources 暴露为只读工具
10. ✅ Prompts 暴露为工具
11. ✅ TUI 显示连接状态 + `!mcp` 命令支持

### 假设（基于合理推断，用户未明确否定）

1. MCP 工具使用双下划线分隔符 `{server}__{tool}` 以避免命名冲突
2. Resources 的资源名从 URI 中提取（如 `db://users/schema` → `users_schema`），可读性优先
3. Prompts 的名称直接使用 MCP Server 返回的名称，下划线替代空格
4. 工具调用超时默认 30 秒（可配置）
5. SSE 连接超时默认 10 秒
6. `!mcp` 命令支持子命令：`list`, `status`, `reconnect`, `disconnect`
7. MCP Manager 的初始化在 `agent.ts` 中 `createClient()` 之后、`render(React.createElement(...))` 之前执行

### 未决问题（留给 planner 决策）

- 是否需要让 MCP Server 的 `env` 字段支持环境变量展开（如 `${HOME}`）？
- SSE 的 `headers` 字段是否应该走安全存储（如 keychain），还是明文写在配置文件中即可？
- 是否需要在 MCP Server 名称中使用 slug 化处理（特殊字符替换），还是直接使用配置中的原始 key？
- `!mcp reconnect` 是否应尝试重新读取配置文件，还是仅重连已断开的 Server（使用上次加载的配置）？
