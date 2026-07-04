# MyAgent Remote — iOS 测试 App

SwiftUI 原生 iOS app，通过 HTTP + SSE 连接到 myagent 的 RemoteServer，实现远程对话控制。

## 功能

- 🔗 SSE 实时接收 agent 响应（聊天消息、工具调用、状态更新）
- 📤 POST 发送用户消息到 myagent
- 💬 聊天气泡式对话界面（user/agent/system/tool 用不同颜色区分）
- 🔄 断线自动重连
- ⚙️ 可配置服务器地址

## 使用方式

### 方案 A：直接打开 Xcode 项目（推荐）

```bash
open ios/MyAgentRemote/MyAgentRemote.xcodeproj
```

然后 Cmd+R 运行。（项目已预配置 ATS，允许本地 HTTP）

### 方案 B：重新生成项目

```bash
cd ios/MyAgentRemote && node gen-xcodeproj.cjs
open MyAgentRemote.xcodeproj
```

### 前提条件

确保 myagent 正在运行：

```bash
npx tsx src/agent.ts --remote
```

> **真机注意**：mac 和 iPhone 需要在同一 WiFi 下，且 serverURL 要改为 mac 的局域网 IP（在 App 的状态栏齿轮按钮中修改），如 `http://192.168.1.100:3099`

## 源码结构

```
ios/MyAgentRemote/
├── MyAgentRemote.xcodeproj/   # Xcode 项目（由 gen-xcodeproj.cjs 生成）
├── gen-xcodeproj.cjs          # 项目生成脚本
├── MyAgentRemote/
│   ├── MyAgentRemoteApp.swift # @main 入口
│   ├── ContentView.swift      # 主界面：对话列表 + 输入框 + 状态栏
│   ├── RemoteClient.swift     # SSE + HTTP 网络层
│   └── Models.swift           # ChatMessage 数据模型
└── README.md
```

## 网络协议

| 方向 | 方式 | 说明 |
|------|------|------|
| App → myagent | `POST /api/message` | 发送 `{"message": "..."}`, JSON body |
| myagent → App | `GET /api/events` (SSE) | 实时事件流，格式 `data: {"type":"...","data":...}` |

### SSE 事件类型

| type | data | 说明 |
|------|------|------|
| `connected` | `{"clientId": N}` | 连接确认 |
| `message` | `{"role":"user/agent/system","content":"..."}` | 聊天消息 |
| `text` | `"delta string"` | 流式文本增量 |
| `status` | `"status text"` | 状态更新 |
| `toolStart` | `{"name":"...","input":{...}}` | 工具调用开始 |
| `toolEnd` | `{"name":"...","output":"..."}` | 工具调用结束 |
| `turnEnd` | text | Turn 结束 |
