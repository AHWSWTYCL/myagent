# CCR（Claude Code Remote）架构调研 — 会话解绑与共享基础设施

> 日期：2026-07-03 | 作者：main agent（对话整理）
> 参考代码库：`Claude-Code`（sourcemap 还原的可运行副本，路径 `/Users/wangshanwu/Documents/Claude-Code`）— 只读研究，未修改该仓库任何代码

---

## 1. CCR 是什么，解决什么问题

CCR 不是"效率优化方案"，也不是"网络安全方案"——那些都是下游副产品。

**核心定位：让一个 session 脱离对单一本机 / 单一进程的绑定（解绑），并支持多个入口同时访问同一个会话（共享）。**

建立在 CCR 之上的三个功能，对应三种不同的解绑/共享需求：

| 功能 | 解决什么 | 关系 |
|------|----------|------|
| **Ultraplan** | 把重规划任务委托给云端 Opus 独立跑 10-30 分钟 | 本地 → 远程的**委托**（正向解绑） |
| **Bridge** | 从 claude.ai 网页/手机遥控本地正在跑的 CLI | 远程 → 本地的**反向控制**（不是委托，方向相反） |
| **Upstream Proxy** | 云端容器网络隔离，需要经本机中转才能访问某些出网资源 | 与"解绑/共享"无直接关系，是纯网络基础设施，附属于 CCR 的容器化前提 |

需要纠正的常见误解：Upstream Proxy 不是"为了解决网络安全问题"而设计的——它存在的因果关系是反的：云端容器**默认没有出网权限**（这是安全隔离的既有前提），Upstream Proxy 只是绕过这个隔离限制的受控 workaround，不是安全方案本身。

---

## 2. 星型拓扑网络模型

本地 CLI、云端 worker、浏览器三方都只主动连接固定域名（`https://api.anthropic.com`，见 `src/constants/oauth.ts:85` 的 `BASE_API_URL`），从不直接连对方的 IP。路由完全由服务端按 `sessionId` 转发。

```
                    ┌─────────────────────────┐
                    │  api.anthropic.com       │
                    │  （固定域名，L7 网关）    │
                    └───┬─────────┬────────┬───┘
                        │         │        │
            sessionId   │         │        │  sessionId
              路由       │         │        │    路由
                        │         │        │
                  ┌─────▼───┐ ┌───▼────┐ ┌─▼──────┐
                  │ 本地 CLI │ │云端worker│ │ 浏览器  │
                  └─────────┘ └────────┘ └────────┘
```

本地永远不知道也不需要知道 remote 的 IP——这是"解绑"在网络层面的直接体现：任何一方掉线重连、换机器、换进程，只要 sessionId 不变，服务端就能把新连接接回同一个会话。

---

## 3. Session 生命周期与状态机

REST 化的 Sessions API：

- `POST /v1/sessions` — 创建
- `GET /v1/sessions/{id}` — 查询元数据（分支、状态等）
- `GET /v1/sessions/{id}/events?after_id=X` — 分页拉取事件（`teleport.tsx` 的 `pollRemoteSessionEvents()`，单次轮询最多翻 `MAX_EVENT_PAGES=50` 页，过滤掉 `env_manager_log`/`control_response` 这类内部事件）

`session_status` 状态机：`requires_action | running | idle | archived`

---

## 4. 双通道同步协议（v2）

不是单一双向连接，而是读写分离的两条通道：

- **读**：`SSETransport` — 订阅 SSE 流，用 `Last-Event-ID` / 序列号做断点续传，天然支持"从哪儿断的就从哪儿续"
- **写**：`CCRClient` — HTTP POST，经 `SerialBatchEventUploader` 批量上传（单批最多 100 条事件）

`src/bridge/replBridgeTransport.ts` 的 `createV2ReplTransport()` 把这两条通道封装成统一接口，并处理 epoch 不匹配（HTTP 409）——遇到 409 直接关闭连接交给上层轮询逻辑重建，而不是原地重试。

同步用到的两套机制搭配使用：

1. **游标/序列号续传**（SSE 原生支持）：适合"我知道自己看到第几条了，从下一条继续"的单向拉取场景
2. **UUID 去重**（Bridge REPL 模式）：`BoundedUUIDSet`（环形缓冲区，容量 2000）——`recentPostedUUIDs` 过滤自己发出去又收到回声的消息，`recentInboundUUIDs` 过滤服务端重投递的入站消息。传输层切换（如 409 后重建连接）时用 `lastTransportSequenceNum` 做序列号继承，避免整段历史重放。

明确排除的方案：**不需要 CRDT/OT**。这两者是为"真正并发编辑同一段文本"设计的冲突消解算法；这里的场景是"追加写的消息流"，用序列号 + 去重就足够了，引入 CRDT/OT 是过度设计。

---

## 5. Epoch 租约仲裁机制

`registerWorker()`（`src/bridge/workSecret.ts`）返回一个单调递增的 `worker_epoch`。当一个 worker 的 epoch 被更新的 worker 顶替后，它的写请求会收到 HTTP 409——这是乐观锁模式，效果类似 Raft/Paxos 的 term number：旧 worker 一旦发现自己"过期"，立刻关闭连接走恢复流程，而不是静默重试造成脑裂。

`src/cli/transports/ccrClient.ts` 中的 `CCRClient` 负责 epoch 生命周期：`PUT /sessions/{id}/worker` 上报状态，`POST /sessions/{id}/worker/heartbeat` 保活（默认间隔 `DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000`）。

---

## 6. 两级认证

| 层级 | 凭证 | 身份对象 | 生命周期 |
|------|------|----------|----------|
| v1 | OAuth accessToken | 人类用户 | 长期，keychain 存储，支持刷新 |
| v2 | JWT | 单个 session 的 worker 进程 | 短期（几小时），claims 里带 `session_id` + worker 角色 |

`src/bridge/jwtUtils.ts` 的 `createTokenRefreshScheduler()` 在 JWT 到期前 5 分钟（`TOKEN_REFRESH_BUFFER_MS`）主动刷新，用 generation counter 保证旧的刷新请求不会覆盖新的结果。

---

## 7. 三级 Git 来源回退（Teleport）

`teleportToRemote()`（`src/utils/teleport.tsx:730`）按优先级尝试：

1. **GitHub 直接 clone** — 前提是 `checkGithubAppInstalled()` 预检通过
2. **Git bundle 上传** — `git bundle --all`（包含未提交的 stash），经 Files API 上传，用 `seed_bundle_file_id` 引用
3. **空 sandbox** — 前两者都不可用时的兜底

保证远程会话总能拿到某种形式的代码上下文，即使用户没装 GitHub App 或仓库没推送。

---

## 8. 网络隔离与隧道（Upstream Proxy）

`src/upstreamproxy/relay.ts`：本地起一个 TCP server，接受 `curl`/`gh`/`kubectl` 发出的 HTTP CONNECT 请求，把字节流用手写的 protobuf（`UpstreamProxyChunk`，一个 `bytes data = 1` 字段）封装后通过 WebSocket 隧道转发给 CCR 服务端；服务端做 TLS 终止 + 注入组织配置的凭证（如 `DD-API-KEY`）+ 转发到真实上游。

存在原因：云端容器默认网络隔离，无法直接出网访问某些资源，只能借本机的网络出口中转。

---

## 9. L4 vs L7 网关，为什么 CCR 选 SSE + HTTP 而不是单一 WebSocket

代码注释原文（`relay.ts`）："CCR ingress is GKE L7 with path-prefix routing; there's no connect_matcher."

```
L4（传输层）网关                        L7（应用层）网关
━━━━━━━━━━━━━━━━━━                    ━━━━━━━━━━━━━━━━━━
只看 IP:Port，字节盲转发                能解析 HTTP 语义，按路径/header路由

┌────┐   TCP流(不解析内容)   ┌────┐    ┌────┐  GET /a  ┌────┐──→ 服务A
│client│ ══════════════════> │后端 │    │client│─────────→│gateway│
└────┘                       └────┘    └────┘  GET /b  └────┘──→ 服务B
```

WebSocket 的握手是一次性的 HTTP 101 Upgrade，之后连接就退化成一条不透明的字节流——L7 网关此后再也看不到"路径"这个语义，因为语义已经消失了。GKE 的这套 L7 + path-prefix 路由模型里没有 `connect_matcher`（原生 TCP 层转发配置），所以长期占用的单一 WebSocket 连接得不到该网关模型的良好支持。

CCR 的应对：**用 SSE 代替单一 WebSocket 做实时推送**。SSE 本质上仍是一个"长时间挂起的普通 HTTP GET"，从网关视角看永远是带路径语义的 HTTP 请求，完全兼容 L7 path 路由；写操作则用普通的 HTTP POST（`CCRClient`）。这就是为什么 CCR 选择 SSE 读 + HTTP 写的分离方案，而不是看起来更直观的单一双向 WebSocket。

**这个选择的适用边界**：只有在基础设施是多租户、由 L7 path-only 网关统一管理入口时，SSE+HTTP 分离才是必要的。如果基础设施允许在网关层配置 TCP/L4 转发规则（如自建 nginx stream 或云厂商的 NLB），单一 WebSocket 依然是更简单、更低延迟的选择。

---

## 10. 行业对比（部分未经一手验证，标注置信度）

| 产品 | 云端执行环境 | 备注 | 置信度 |
|------|--------------|------|--------|
| GitHub Copilot coding agent | GitHub Actions 里的容器 | 出网走 firewall allowlist 模型 | WebSearch，未读官方架构文档 |
| Cursor Cloud Agents | 每个 agent 独立云 VM | 用 ACP（Agent Client Protocol）做跨编辑器通信 | ACP 协议名称已确认，其余未验证（WebFetch 到 cursor.com 被拦截） |
| Google Jules | 异步云 VM 执行 | — | WebSearch，未验证 |
| OpenAI Codex | 隔离 sandbox 容器 | — | WebSearch，未验证 |

---

## 11. 我自己的替代设计方案（原创，非 CCR 复述）

被问到"如果让你从零实现一套，你会怎么设计"时给出的方案，明确标注哪些地方认同 CCR 的做法、哪些地方有分歧及理由：

| 模块 | CCR 实际做法 | 我的方案 | 关系 |
|------|--------------|----------|------|
| Session 存储 | Sessions API（黑盒） | Postgres 里的一行，带 `owner_epoch` 列 | 保留租约仲裁思路，换存储形态 |
| 事件流 | 分页 events API | `session_events` 表，**per-session**（非全局自增）的 `seq` 列做续传游标 | 保留概念 |
| 实时传输 | SSE（读）+ HTTP POST（写）分离 | **默认单一双向 WebSocket**；但前提是基础设施不强制 L7 path-only 路由——若强制，则采用 CCR 的 SSE+HTTP 分离方案 | 有条件分歧，见第 9 节 |
| Worker 租约 | epoch + 409 拒绝旧 worker | 保留 epoch，**新增**：服务端在心跳超时后主动 bump epoch 抢占，不等 stale worker 自己发现 | 增强 |
| 去重 | 内存 `BoundedUUIDSet` 环形缓冲 | 保留 UUID 思路，但把 `unique(session_id, client_uuid)` 数据库约束作为唯一真相源；内存去重只是性能优化，不是最后防线 | 增强（更强一致性保证） |
| 代码来源回退 | GitHub clone → git bundle → 空 sandbox 三级 | 保留三级回退，**新增** sha256 内容哈希校验上传的 bundle | 增强（完整性校验） |
| 容器出网 | 本机 relay 隧道（Upstream Proxy） | **改为**服务端网络 allowlist/firewall（类似 GitHub Copilot 模式）；本机隧道降级为访问用户私有局域网资源时的显式 opt-in fallback | 分歧——理由：本机隧道重新引入了"必须本机保持在线"的依赖，这和 CCR"解绑"的核心设计目标是矛盾的 |
| 认证 | OAuth（人）+ JWT（worker，短期） | 保留两级分离，**新增**：把 epoch 直接编码进 JWT claims，省掉一次 DB 查询 | 增强 |

---

## 12. 关键源码索引（Claude-Code 仓库）

| 文件 | 职责 |
|------|------|
| `src/constants/oauth.ts` | 固定域名 `BASE_API_URL` 定义，验证星型拓扑 |
| `src/utils/teleport.tsx` | `teleportToRemote()`、三级 git 来源回退、`pollRemoteSessionEvents()` |
| `src/utils/teleport/api.ts` | Sessions API 客户端（`fetchSession`/`sendEventToRemoteSession`） |
| `src/utils/ultraplan/ccrSession.ts` | `ExitPlanModeScanner`（纯状态机）、`pollForApprovedExitPlanMode()` |
| `src/bridge/replBridgeTransport.ts` | v1/v2 传输层统一封装，epoch 409 处理 |
| `src/bridge/replBridge.ts` | UUID 去重（`recentPostedUUIDs`/`recentInboundUUIDs`）、SSE 序列号继承 |
| `src/bridge/jwtUtils.ts` | JWT 解析、主动刷新调度 |
| `src/bridge/workSecret.ts` | `registerWorker()`、work secret 解码、SDK URL 构造 |
| `src/cli/transports/ccrClient.ts` | Worker 生命周期管理、epoch、heartbeat |
| `src/upstreamproxy/relay.ts` | CONNECT-over-WebSocket 隧道，手写 protobuf 编解码 |
| `src/commands/review/reviewRemote.ts` | `/ultrareview` 的 bughunter 多代理 fleet 配置 |
| `docs/03-ultraplan.md` / `docs/06-bridge.md` | 项目内文档，功能概览 |

---

## 13. 参考

- Claude-Code 源码阅读 + 讨论整理（本文档为该讨论的知识沉淀）
- Git Worktree 隔离方案调研见同目录 [`git-worktree-agent-isolation.md`](./git-worktree-agent-isolation.md)（不同主题，仅作风格参照）
