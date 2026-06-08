# Git Worktree 实现 Agent 文件系统隔离 — 调研报告

> 日期：2025-01-26 | 作者：main agent + advisor

---

## 1. 问题现状

### 1.1 当前 agent 的共享范围

```
┌─────────────────────────────────────────────────────────┐
│                    myagent 进程空间                       │
│                                                         │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│  │  main    │   │ sub-agent│   │ teammate │            │
│  │  agent   │   │ (同步)    │   │ (bg proc)│            │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘            │
│       │               │               │                 │
│       └───────────────┼───────────────┘                 │
│                       │                                 │
│              ┌────────▼────────┐                        │
│              │  同一个 cwd()    │  ← 所有 agent 共享      │
│              │  同一个 .git/   │  ← 同一个 git 状态       │
│              │  同一套文件系统  │  ← 读写互相覆盖          │
│              └─────────────────┘                        │
└─────────────────────────────────────────────────────────┘
```

**共享的具体资源：**

| 资源 | 共享方式 | 风险 |
|------|----------|------|
| 工作目录 (`cwd()`) | 所有 agent 使用 `process.cwd()` | 并行 agent 写同一文件会互相覆盖 |
| `.git/` 目录 | 同一个仓库 | `git add/commit` 互相干扰，无法独立追踪 |
| `node_modules/` | 共享安装 | 一个 agent 的 `npm install` 影响其他 agent |
| `~/.myagent/` 下的数据 | 邮箱/team/memory 等 | 设计上应共享（通信基础设施） |

### 1.2 并行 agent 场景

```
时间 →

main agent  ──────────────────────────────────────────────
                  │                    │
                  │ spawn(bg)          │ spawn(bg)
                  ▼                    ▼
generator   ── 写 src/foo.ts      写 src/bar.ts  ──  OK（不同文件）
verifier    ── 读 src/foo.ts      读 src/bar.ts  ──  OK
                  │
                  │ spawn(bg)
                  ▼
generator-2 ── 写 src/foo.ts  ← ⚠️ 与 generator 冲突！
```

当前没有任何机制防止两个 agent 修改同一文件。如果 main agent 同时派 generator 和另一个 generator 并行修改同一个文件，后写入的覆盖先写入的。

---

## 2. Git Worktree 机制

### 2.1 概念

```
┌──────────────────────────────────────────────────────────┐
│                    .git/ (共享对象库)                      │
│  objects/  refs/  hooks/  config  ...                    │
│                                                          │
│  worktrees/                                              │
│    ├── agent-wk-1/      ← 元数据（HEAD, index, ...）      │
│    └── agent-wk-2/                                       │
└──────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   /project/main        /tmp/wt/wk-1       /tmp/wt/wk-2
   (主 worktree)        (linked worktree)   (linked worktree)
   HEAD → main          HEAD → agent/wk-1   HEAD → agent/wk-2
```

- **共享**：一个 `.git/` 对象库，所有 worktree 共享 commits/blobs/trees
- **隔离**：每个 worktree 有独立的工作目录 + 独立的 index（暂存区）+ 独立的 HEAD
- **轻量**：`git worktree add` 只是 checkout 文件 + 写少量元数据，不复制 `.git/`

### 2.2 关键命令

```bash
# 创建 worktree（在新分支上）
git worktree add -b agent/wk-1 /tmp/myagent-worktrees/wk-1 main

# 创建 detached worktree（不需要新分支，适合临时实验）
git worktree add --detach /tmp/myagent-worktrees/wk-1 main

# 列出所有 worktree
git worktree list

# 删除 worktree + 清理元数据
git worktree remove /tmp/myagent-worktrees/wk-1

# 清理已删除但未 remove 的 worktree 元数据
git worktree prune
```

### 2.3 限制与注意

1. **同一分支不能同时在两个 worktree 中 checkout**（除非用 `--detach`）
2. **不能嵌套**：linked worktree 不能在主 worktree 目录内
3. **子模块**：每个 worktree 需要独立 `git submodule update --init`
4. **未跟踪文件**：`git worktree remove` 不会自动清理未跟踪文件（需 `-f` 强制删除）

---

## 3. 方案设计

### 3.1 核心思路

```
┌──────────────────────────────────────────────────────────┐
│                    myagent 进程空间                       │
│                                                          │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐            │
│  │  main    │   │generator │   │verifier  │            │
│  │  agent   │   │(sub)     │   │(sub)     │            │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘            │
│       │               │               │                 │
│  cwd: /project    cwd: /tmp/      cwd: /tmp/           │
│       │            wt/wk-1        wt/wk-2              │
│       │               │               │                 │
│  ┌────▼───────────────▼───────────────▼────────┐        │
│  │              ~/.myagent/                    │        │
│  │  mailbox/  teams/  memory/  ...             │        │
│  │  (仍然共享 — 通信基础设施)                    │        │
│  └─────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────┘
```

**每个 agent 获得自己的 worktree → 自己的文件系统视图。** 通信仍通过共享的 `~/.myagent/` 基础设施。

### 3.2 两种粒度的隔离

#### 方案 A：每个 agent 调用一个 worktree（细粒度）

- generator 修改 `src/foo.ts` → 在 worktree A 中
- verifier 读取 `src/foo.ts` → 在 worktree B 中（看不到 generator 的修改）
- 需要通过 git commit/push 或显式 merge 来"交接"结果

**流程：**
```
main ──spawn──▶ generator ──写 src/foo.ts──▶ git commit ──▶ send_mail(result)
                      │
                      ▼
               worktree: /tmp/wt/wk-1 (branch: agent/wk-1)

main ──spawn──▶ verifier ──从哪个 commit 验证？需要拿到 generator 的 commit hash
```

**优点**：隔离最彻底，每个 agent 有独立 git 历史
**缺点**：agent 间协作需要显式 git 操作来传递结果，对于 demo 项目来说太重

#### 方案 B：只在显式需要隔离时创建 worktree（粗粒度）

- 默认 sub-agent 共享主 worktree（当前行为）
- 只有用户显式要求隔离（如 `--isolated` flag）或 team 模式下才创建 worktree
- teammate 独立进程天然需要 worktree（独立 cwd）

**流程：**
```
# 默认：共享 cwd（当前行为，无改动）
agent("generator", task="改 src/foo.ts")  → cwd = /project (共享)

# 显式隔离
agent("generator", task="重构 src/", isolated=true)  → 创建 worktree

# team 模式（已有独立进程）
leader 派 teammate  → teammate 在独立 worktree 中运行
```

**优点**：渐进式，不破坏现有行为，复杂度可控
**缺点**：隔离不默认，用户需要知道何时用

#### 方案 C：per-team worktree（团队粒度）

- 创建一个 team 时，自动为该 team 创建一个 worktree
- team 内所有 agent（leader + teammates）共享同一个 worktree
- 不同 team 之间完全隔离

**流程：**
```
Team "frontend" ──── worktree: /tmp/wt/team-frontend
  ├── leader (main 或专用)
  ├── generator (wk-1)
  └── verifier (wk-2)
       │
       所有 agent 共享同一个 worktree → 可以直接看到彼此的文件修改

Team "backend" ──── worktree: /tmp/wt/team-backend
  └── generator (wk-3)
       │
       与 frontend team 完全隔离
```

**优点**：team 内协作自然（共享文件系统），team 间隔离清晰
**缺点**：team 内仍有冲突风险（多个 agent 写同一文件）

### 3.3 方案对比

| 维度 | 方案 A（per-agent） | 方案 B（按需隔离） | 方案 C（per-team） |
|------|---------------------|---------------------|---------------------|
| 隔离粒度 | 最细 | 灵活 | 中等 |
| 改动量 | 大（所有 agent 路径） | 小（加 cwd 参数） | 中（team 创建逻辑） |
| 磁盘开销 | 多个 worktree | 按需 | per-team |
| agent 间协作 | 需显式 git 操作 | 默认共享，隔离时需 git | team 内自然共享 |
| 适合场景 | 高安全需求 | demo 项目 | 多团队并行开发 |
| demo 适用性 | ❌ 过重 | ✅ 推荐 | ⚠️ 中等 |

---

## 4. 技术实现要点

### 4.1 实现路径（方案 B 渐进路线）

```
Phase 1: 给 AgentRunContext 加 workspacePath
    ↓
Phase 2: 让文件工具支持 workspacePath 重定向
    ↓
Phase 3: 实现 worktree 创建/销毁的封装
    ↓
Phase 4: 集成到 agent 生命周期（创建时 setup，销毁时 teardown）
```

### 4.2 需要改动的核心点

#### a) `AgentRunContext` 加 `workspacePath`

```typescript
// src/agents/definition.ts
export interface AgentRunContext {
  // ... 现有字段 ...
  
  /** agent 的工作目录。不设则使用 process.cwd()（当前行为）。 */
  workspacePath?: string
}
```

#### b) 文件工具支持 `workspacePath`

当前所有工具使用 `process.cwd()` 或 `path.resolve()`，需要改为支持可注入的 root：

```typescript
// 现状：所有工具硬编码 cwd
const resolvedPath = path.resolve(filePath)

// 目标：工具感知 workspacePath
function resolveInWorkspace(filePath: string, workspacePath?: string): string {
  const root = workspacePath ?? process.cwd()
  return path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath)
}
```

影响范围（所有文件系统工具）：

| 工具 | 改动 |
|------|------|
| `ReadTool` | `path.resolve(filePath)` → `resolveInWorkspace(filePath, ctx.workspacePath)` |
| `WriteTool` | 同上 + cwd() 安全检查 |
| `EditTool` | 同上 |
| `BashTool` | `spawn('bash', ..., { cwd: cwd() })` → `cwd: ctx.workspacePath ?? cwd()` |
| `GlobTool` | 默认搜索路径 |
| `GrepTool` | 默认搜索路径 |
| `ListDirTool` | 默认列出路径 |

#### c) Worktree 生命周期管理

```typescript
// src/agents/worktree.ts (新文件)

export interface WorktreeHandle {
  path: string       // 工作目录绝对路径
  branch: string     // 分支名
  commit: string     // 创建时的 commit hash
}

export const WorktreeManager = {
  /** 创建 worktree，返回工作目录路径 */
  async create(agentId: string, baseBranch?: string): Promise<WorktreeHandle> {
    const branch = `myagent/${agentId}-${Date.now().toString(36)}`
    const dir = path.join(os.tmpdir(), 'myagent-worktrees', agentId)
    
    // git worktree add -b <branch> <dir> <baseBranch>
    await execGit(['worktree', 'add', '-b', branch, dir, baseBranch ?? 'HEAD'])
    
    return { path: dir, branch, commit: await getHeadCommit(dir) }
  },

  /** 删除 worktree + 清理 */
  async destroy(handle: WorktreeHandle): Promise<void> {
    // git worktree remove <path> --force
    await execGit(['worktree', 'remove', handle.path, '--force'])
  },

  /** 在 worktree 中执行 git 操作（add/commit/push） */
  async commit(handle: WorktreeHandle, message: string): Promise<string> {
    await execGit(['-C', handle.path, 'add', '-A'])
    await execGit(['-C', handle.path, 'commit', '-m', message])
    return getHeadCommit(handle.path)
  },
}
```

### 4.3 挑战：工具如何拿到 `workspacePath`

当前工具通过 `ToolRegistrar` 注册，execute 方法的签名是 `execute(args, signal)`，不感知 agent 上下文。有几种方案：

**方案 i：通过 ToolRegistrar 传递（推荐）**

```typescript
// 在 subRegistrar 构建时注入 workspacePath
const subRegistrar = new ToolRegistrar({ workspacePath: wtPath })
// 每个工具从自己的注册上下文获取 workspacePath
```

**方案 ii：通过全局变量/AsyncLocalStorage**

```typescript
// Node.js AsyncLocalStorage 适合异步上下文传递
const workspaceContext = new AsyncLocalStorage<string>()
// 在 runAgent 中设置，工具通过 workspaceContext.getStore() 读取
```

**方案 iii：每个工具 execute 时传额外参数**

改动签名影响太大，不考虑。

对于 demo 项目，方案 i 最直接。

### 4.4 agent 生命周期集成

```
spawn agent (isolated=true)
  │
  ├─ 1. WorktreeManager.create(agentId)
  │     └─ git worktree add -b myagent/wk-1 /tmp/.../wk-1 main
  │
  ├─ 2. 构建 AgentRunContext { workspacePath: "/tmp/.../wk-1" }
  │
  ├─ 3. runAgent(def, args, ctx)
  │     └─ 所有文件操作在 worktree 内
  │
  ├─ 4. (可选) 如果 agent 成功，可以 git commit 自动保存结果
  │
  └─ 5. WorktreeManager.destroy(handle)
        └─ git worktree remove --force
```

---

## 5. 总结与建议

### 5.1 对于 myagent demo 项目

**建议采用方案 B（按需隔离），分 2 个 Phase 渐进实现：**

#### Phase 1（最小可用）：workspacePath 支持
- `AgentRunContext` 加 `workspacePath?: string`
- 所有文件系统工具支持 `workspacePath` 重定向（不改默认行为）
- BashTool 支持自定义 `cwd`
- 不做 worktree 创建/销毁

**价值**：Phase 1 完成后，即使不创建 worktree，也能让 agent 在任意目录下工作。比如可以让 agent 在 `/tmp/sandbox` 下实验，不污染项目目录。

#### Phase 2（worktree 集成）：完整的 worktree 生命周期
- `WorktreeManager` 封装 create/destroy
- 在 `AgentTool.runInBackground` 中：`isolated=true` 时创建 worktree
- 在 `finishBackgroundAgent` 中清理 worktree
- teammate 独立进程默认使用 worktree（天然场景）

### 5.2 不做的事情（留给未来）

- ❌ 自动合并 worktree 的 commit 回主分支（需要冲突解决策略，太重）
- ❌ 嵌套 agent 的 worktree 继承链
- ❌ worktree 的磁盘配额管理
- ❌ 跨 worktree 的 git diff/rebase

### 5.3 关键风险

1. **磁盘空间**：每个 worktree checkout 完整项目文件（不含 `.git/objects`），对于大项目可能几百 MB。需要清理策略。
2. **node_modules**：每个 worktree 需要独立 `npm install`，耗时且占空间。可以考虑 symlink 到主 worktree 的 node_modules。
3. **git 锁**：同一分支不能同时 checkout 到两个 worktree。需要用 `--detach` 或唯一分支名。
4. **未跟踪文件的清理**：`git worktree remove` 不删未跟踪文件。`--force` 可以，但意味着 agent 的中间产物会丢失。

---

## 6. 参考

- [Git Worktree 官方文档](https://git-scm.com/docs/git-worktree)
- 并行 git 工作流的经典场景：`git worktree` 用于同时修 bug 和开发 feature
- Claude Code 本身不使用 worktree（单一 agent，无隔离需求）
