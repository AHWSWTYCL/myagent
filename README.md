```
  ┌──────────────────────────┐
  │                          │
  │       __o                │
  │     _ \<_    myagent     │
  │    (_)/(_)               │
  │                          │
  └──────────────────────────┘
```

阅读了 Claude Code 源码后，自己动手实现的一个 AI agent demo，主要用于学习。

> ⚠️ **demo 项目**：功能覆盖了 Claude Code 的核心交互模式（TUI + 工具调用 + agent 委派），但不做生产级保障。

---

## 目录

- [前置依赖](#前置依赖)
- [快速开始](#快速开始)
- [配置 API 提供商](#配置-api-提供商)
- [运行](#运行)
- [命令参考](#命令参考)
- [项目结构](#项目结构)

---

## 前置依赖

- **Node.js** >= 18（推荐 20+）
- **npm** >= 9

## 快速开始

```bash
# 1. 克隆项目
git clone <repo-url> && cd myagent

# 2. 安装依赖
npm install

# 3. 配置 API Key（任选一个提供商）
#    见下方配置说明

# 4. 运行
npm run agent
```

## 配置 API 提供商

项目读取 `~/.claude/settings-using-deepseek.json`（硬编码路径，可在 `src/config.ts` 中修改）中的环境变量来初始化 API 客户端。

### 选项 A：DeepSeek（Anthropic 兼容接口）

DeepSeek 提供了 Anthropic Messages API 的兼容端点，**无需 Anthropic 官方 Key**，价格更低。

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-你的DeepSeek API Key"
  }
}
```

| 字段 | 说明 |
|------|------|
| `ANTHROPIC_BASE_URL` | DeepSeek 兼容端点 `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_AUTH_TOKEN` | 你在 [DeepSeek 平台](https://platform.deepseek.com/) 申请的 API Key |

> **⚠️ 已知限制**：DeepSeek 兼容接口不支持 prompt caching（`cache_control` 会被静默忽略，不影响功能）。

### 选项 B：Anthropic 官方 API

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-你的Anthropic API Key"
  }
}
```

| 字段 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | 你在 [Anthropic Console](https://console.anthropic.com/) 申请的 API Key |
| `ANTHROPIC_AUTH_TOKEN` | 二选一，优先级高于 `API_KEY` |
| `ANTHROPIC_BASE_URL` | 可选，用于自定义代理或中转地址 |

### 选项 C：其他兼容提供商

设置 `ANTHROPIC_BASE_URL` 指向任意兼容 Anthropic Messages API 的端点即可：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-proxy.example.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "你的API Key"
  }
}
```

### 认证优先级

`ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY`，两者都提供时走 `AUTH_TOKEN`。

### 配置文件路径说明

- **默认路径**：`~/.claude/settings-using-deepseek.json`
- 如果想改用 Claude Code 的标准配置文件，在 `src/config.ts` 中将 `settings-using-deepseek.json` 改为 `settings.json` 即可。

---

## 运行

| 命令 | 说明 |
|------|------|
| `npm run agent` | 启动 TUI 交互模式（默认） |
| `npm run start` | 启动已编译的生产版本 |
| `npm run hello` | 运行 hello 测试 |
| `npm test` | 运行测试套件 |

### 调试模式（Headless）

传入 `--debug` 参数可直接执行单次 prompt 并输出 JSON 结果：

```bash
tsx src/agent.ts --debug "你的prompt"
```

可选参数：
- `--output <path>` 将结果写入文件
- `--auto-yes` 静默授权所有工具调用
- `--timeout <seconds>` 超时自动中断

示例：

```bash
tsx src/agent.ts --debug "列出当前目录的文件" --output result.json --timeout 120
```

---

## 命令参考

在 TUI 中输入以下命令：

| 命令 | 说明 |
|------|------|
| `!<bash命令>` | 直接执行 Shell 命令，结果推回对话 |
| `!mcp <子命令>` | MCP 服务器管理 |
| `/help` | 显示帮助信息 |
| `/skill` | 管理技能（激活/停用） |
| `/task` | 管理任务看板 |
| `/retro` | 执行回顾反思 |
| `/token` | 查看当前会话 Token 用量 |
| `/schedule` | 管理定时任务 |

---

## 项目结构

```
src/
├── agent.ts            # 主入口，TUI + 调试模式
├── client.ts           # Anthropic SDK 客户端 + 重试逻辑
├── config.ts           # 配置加载（API Key / Base URL）
├── prompt/             # System Prompt 构建
├── memory/             # 自动记忆系统
├── tools/              # 工具定义（read/write/bash 等）
├── agents/             # Sub-agent 系统
├── skills/             # 技能系统
├── hooks/              # 生命周期钩子
├── commands/           # 斜杠命令
├── tui/                # 终端 UI（React + Ink）
├── scheduler/          # 定时任务调度
├── tasks/              # 任务看板系统
├── mcp/                # MCP 协议支持
├── todos/              # Todo 面板
└── attachment/         # 附件队列管理
```

---

> 项目受 Claude Code 启发，代码结构参考了其核心设计思路，但做了大量简化和面向学习的改动。
