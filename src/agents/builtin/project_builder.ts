import { spawn } from 'child_process'
import { cwd } from 'process'
import { AgentDefinition, AgentRunContext } from '../definition.js'
import { Tool } from '../../tools/tool.js'

// ── 构建专用的 bash 工具（shadow 全局 bash，timeout 更长，流式输出） ────────

const BUILD_TIMEOUT_MS = 300_000     // 5 分钟
const KILL_GRACE_MS = 2_000          // SIGTERM 后 2 秒再 SIGKILL
const BUILD_MAX_OUTPUT_BYTES = 200_000  // 返回给 LLM 的最大字节数
const HEARTBEAT_MS = 15_000           // 静默超过此时长就推一次心跳，避免 TUI 看起来卡死

const BLACKLIST: { pattern: RegExp; reason: string }[] = [
  { pattern: /rm\s+.*-[a-z]*r[a-z]*f|rm\s+.*-[a-z]*f[a-z]*r/i, reason: 'recursive force delete (rm -rf) is not allowed' },
  { pattern: /rm\s+.*[\s'"`]\/['"`]?\s*$|rm\s+.*[\s'"`]\/\*/i, reason: 'deleting root directory is not allowed' },
  { pattern: /mkfs\b/i, reason: 'disk formatting (mkfs) is not allowed' },
  { pattern: /dd\s+.*of=\/dev\/(sd|hd|nvme|disk)/i, reason: 'writing to raw disk device is not allowed' },
  { pattern: />\s*\/etc\/(passwd|shadow|hosts|sudoers)/i, reason: 'overwriting system files is not allowed' },
  { pattern: /:\(\)\s*\{.*:.*\|:.*\}/i, reason: 'fork bomb is not allowed' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'system shutdown/reboot is not allowed' },
]

/**
 * 异步流式 bash 工具：
 * - 用 spawn 而非 execSync，绝不阻塞主 event loop
 * - stdout / stderr 增量实时推送到 onSubAgentDelta，TUI 可以看到构建进度
 * - 5 分钟超时；超时后 SIGTERM → 2 秒后 SIGKILL
 * - 返回给 LLM 的内容截断到 200 行，避免 token 爆炸
 */
class BuildBashTool extends Tool {
  constructor(
    private agentName: string,
    private onDelta?: (name: string, delta: string) => void,
    private onHeartbeat?: (name: string, elapsedMs: number) => void,
  ) { super() }

  get name(): string { return 'bash' }
  get description(): string {
    return 'Execute a bash command in the project directory. ' +
      'Configured with extended timeout (5 min) suitable for builds and dependency installation. ' +
      'Output is streamed to the UI in real-time. ' +
      'Use this for: detecting toolchains, installing dependencies, running build commands, verifying artifacts.'
  }
  get input_schema() {
    return {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    }
  }

  async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const command = (args.command ?? '') as string
    for (const { pattern, reason } of BLACKLIST) {
      if (pattern.test(command)) return `[BLOCKED] ${reason}\nCommand: ${command}`
    }
    return runStreamingBash(command, this.agentName, this.onDelta, this.onHeartbeat, signal)
  }
}

function runStreamingBash(
  command: string,
  agentName: string,
  onDelta?: (name: string, delta: string) => void,
  onHeartbeat?: (name: string, elapsedMs: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,  // 创建新进程组，确保 kill 能传播到 cargo 及其子进程
      env: {
        ...process.env,
        // 让常见运行时尽量不要做行缓冲，这样进度可以实时流出
        PYTHONUNBUFFERED: '1',
        // npm / pip / cargo 的 TTY 进度条在非 TTY 下会自动降级为按行输出，符合预期
        // 强制 cargo 走人类可读输出（已是默认，但显式声明便于将来切换 json 模式）
        CARGO_TERM_PROGRESS_WHEN: 'never',
        // sparse registry：用 HTTP 拉 crates.io 索引代替 git fetch，避免「Updating crates.io index」长期静默
        // cargo 1.68+ 默认开启，旧版本通过环境变量启用
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
        // 用系统 git CLI 抓 git 依赖（含 git 协议的镜像源），libgit2 不暴露 fetch 进度，
        // 切到 git CLI 后能看到 "Receiving objects: 87% ..." 这种实时进度。
        CARGO_NET_GIT_FETCH_WITH_CLI: 'true',
      },
    })

    let buffer = ''
    let truncatedBytes = 0
    const startedAt = Date.now()
    let lastDataAt = startedAt

    // 立刻推一行「正在执行的命令」到 TUI，避免命令启动初期完全空白
    onDelta?.(agentName, `$ ${command}\n`)

    const append = (chunk: string) => {
      lastDataAt = Date.now()
      onDelta?.(agentName, chunk)
      if (buffer.length + chunk.length <= BUILD_MAX_OUTPUT_BYTES) {
        buffer += chunk
      } else {
        const room = Math.max(0, BUILD_MAX_OUTPUT_BYTES - buffer.length)
        if (room > 0) buffer += chunk.slice(0, room)
        truncatedBytes += chunk.length - room
      }
    }

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    // 心跳：命令静默超过 HEARTBEAT_MS 就向 TUI 发一次心跳事件，TUI 自己渲染动画。
    // 不写入 buffer，也不走 onDelta（避免在文本面板里堆心跳行），用专用回调。
    const heartbeat = setInterval(() => {
      if (Date.now() - lastDataAt >= HEARTBEAT_MS) {
        onHeartbeat?.(agentName, Date.now() - startedAt)
      }
    }, 500)

    const killProcessGroup = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig) } catch { /* already dead */ }
    }

    let timedOut = false
    let aborted = false
    let killTimer: NodeJS.Timeout | null = null
    const timeout = setTimeout(() => {
      timedOut = true
      killProcessGroup('SIGTERM')
      killTimer = setTimeout(() => {
        killProcessGroup('SIGKILL')
      }, KILL_GRACE_MS)
    }, BUILD_TIMEOUT_MS)

    // ── AbortSignal 支持：用户按 Esc 时杀掉整个进程组 ──────────
    const onAbort = () => {
      aborted = true
      clearTimeout(timeout)
      killProcessGroup('SIGTERM')
      killTimer = setTimeout(() => {
        killProcessGroup('SIGKILL')
      }, KILL_GRACE_MS)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (err) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      clearInterval(heartbeat)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(`Error spawning bash: ${err.message}\nCommand: ${command}`)
    })

    child.on('close', (code, sig) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      clearInterval(heartbeat)
      if (signal) signal.removeEventListener('abort', onAbort)

      const tail = tailLines(buffer, 200)
      const tailNote = tail.truncated
        ? `\n\n...（输出已截断，原始 ${tail.totalLines} 行，仅保留末尾 200 行）`
        : ''
      const bytesNote = truncatedBytes > 0
        ? `\n\n...（${truncatedBytes} 字节因超出 ${BUILD_MAX_OUTPUT_BYTES} 上限被丢弃）`
        : ''

      if (aborted) {
        resolve(`Cancelled by user.\n${tail.text || '(no output)'}${bytesNote}`)
        return
      }
      if (timedOut) {
        resolve(`Timed out after ${BUILD_TIMEOUT_MS / 1000}s (signal=${sig ?? 'SIGTERM'}):\n${tail.text}${tailNote}${bytesNote}`)
        return
      }
      if (code === 0) {
        resolve(tail.text || '(no output)')
        return
      }
      resolve(`Exit code ${code ?? '?'}${sig ? ` (signal ${sig})` : ''}:\n${tail.text || '(no output)'}${tailNote}${bytesNote}`)
    })
  })
}

function tailLines(text: string, n: number): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split('\n')
  if (lines.length <= n) return { text, truncated: false, totalLines: lines.length }
  return { text: lines.slice(-n).join('\n'), truncated: true, totalLines: lines.length }
}

// ── System Prompt ───────────────────────────────────────────────────────

const SYSTEM = `你是一个项目环境搭建与构建专家（project_builder）。你被调用来完成以下任务之一：

- 搭建一个新项目的开发环境（检测工具链 → 安装依赖 → 构建 → 验证产物）
- 重新构建并验证现有项目的构建产物

你按以下 6 个阶段依次执行，**不要跳过任何阶段**。

---

## 阶段 0：阅读项目自带的构建文档（必做）

在做任何"猜"之前，先读项目自己写的构建/编译说明。优先级从高到低：

1. \`README\`、\`README.md\`、\`README.rst\`、\`README.txt\` 中的 "Build" / "Building" / "Install" / "Getting Started" / "Compile" 段落
2. \`BUILDING.md\`、\`BUILD.md\`、\`INSTALL.md\`、\`CONTRIBUTING.md\`、\`docs/build*\`、\`docs/install*\`
3. 项目网站（README 中给出的链接，如有 fetch 工具可读）
4. CI 配置作为兜底证据：\`.github/workflows/*.yml\`、\`.gitlab-ci.yml\`、\`Jenkinsfile\`、\`.circleci/config.yml\`、\`Makefile\` 中 \`ci:\` / \`build:\` target——CI 跑得通的命令就是项目作者认可的构建命令

**怎么用文档**：
- 项目文档里写的命令 **优先于** 后面阶段 3 列出的"通用命令"。例如 README 写的是 \`./scripts/setup.sh && make release\`，就先用这个，别擅自改成 \`cargo build\`。
- 文档里如果列出**前置依赖**（需要某版本工具链等），按文档要求做，不要凭直觉跳步。
- 文档里如果有"构建参数选项"（feature flag、build profile、target 列表），先选 **默认/最小可工作的那一组**——见阶段 3 的"主体优先"原则。

### git submodule 处理规则（必须询问用户）

如果文档或构建过程要求执行 \`git submodule update --init\`（或 \`--recursive\`），**不要自动执行**，先用 \`ask_user\` 询问：

> 「该项目包含 git submodule（子模块）。初始化 submodule 会拉取额外的代码仓库，可能耗时较长且占用较多磁盘空间。是否要初始化 submodule？」

- 用户确认 → 执行 \`git submodule update --init\`（如文档要求 \`--recursive\` 则加上）
- 用户拒绝 → 跳过 submodule，继续尝试构建主体；在"已跳过的子组件"章节注明「用户选择不初始化 submodule，以下子模块未拉取：\`<list>\`」
- 如果跳过 submodule 导致构建失败，在"未解决的问题"章节说明，并提示用户重新运行时选择初始化

**没有任何构建文档**：明确记录这一事实，再回退到阶段 1 的通用规则。

---

## 阶段 1：项目类型检测

在项目根目录查找以下文件（按优先级从高到低），确定项目类型：

| 构建描述文件 | 项目类型 |
|---|---|
| Cargo.toml | Rust (cargo) |
| go.mod | Go |
| package.json | Node.js / JavaScript / TypeScript |
| pom.xml | Java (Maven) |
| build.gradle / build.gradle.kts | Java (Gradle) |
| pyproject.toml | Python (PEP 517) |
| requirements.txt / setup.py | Python (pip) |
| CMakeLists.txt | C/C++ (CMake) |
| Makefile | 通用 Makefile（最后兜底） |

**优先级规则**：有多个构建文件时，取上表中排位更靠前的。例如 Cargo.toml + Makefile → Rust 项目。
**空项目**：没有任何已知构建文件 → 报错退出，列出已查找的各类文件。

---

## 阶段 2：环境检测与依赖安装

### 2a. 检测工具链
确认构建所需的核心工具链已安装（如 rustc、gcc/clang、go、node、java、python3 等）。
- 如果缺失 → 报错提示用户手动安装，附带安装指引链接
- **不要自动安装系统级工具链**

### 2b. 安装项目级依赖
自动安装项目级的包依赖：
- Node.js → npm install（使用 --registry 指定镜像源，如 https://registry.npmmirror.com）
- Rust → 不自动装依赖（cargo build 会自动下载，但优先配置镜像源）
- Go → GOPROXY=https://goproxy.cn,direct go mod download
- Python → pip install -r requirements.txt 或 pip install -e .（使用 -i 指定镜像源，如 https://pypi.tuna.tsinghua.edu.cn/simple）
- Java → mvn dependency:resolve 或 gradle dependencies（使用镜像仓库）
- C/C++ → 酌情安装子依赖（如 apt-get install libxxx-dev）
- 其他 → 根据项目文档判断

**始终优先使用镜像源**：上述每个涉及下载的操作，只要对应生态有已知可用的国内镜像源，必须使用。这能显著降低因网络问题导致的安装失败。

### 2c. 下载/网络失败重试上限（硬性规则）

涉及下载的命令（\`npm install\` / \`go mod download\` / \`pip install\` / \`mvn dependency:resolve\` / \`cargo fetch\` / \`git clone\` / \`apt-get\` 等）失败时：

- **同一条命令最多重试 3 次**（含首次共 4 次执行）。每次重试前先排查根因再决定怎么改：
  1. **第 1 次重试**：原命令直跑（很多失败是瞬时网络抖动）
  2. **第 2 次重试**：换/启用镜像源（如果还没用），或调整超时参数
  3. **第 3 次重试**：换替代方案（不同包管理器、手动下载、跳过可选依赖）
- 3 次后仍失败 → **停止重试**，把 4 次的错误日志摘要写进"未解决的问题"章节，让调用方决定。
- 不允许"靠次数硬刷"——每次失败都必须读错误日志，能判断是确定性失败的（如 404、auth 错误）就立刻停止，不要凑满 3 次。

安装失败时，捕获错误信息，尝试分析根因（网络问题？版本冲突？权限？）并报告。

---

## 阶段 3：构建/编译

### 3a. 主体优先原则（核心）

**先让"主体目标"编译成功；非主体的难啃组件可以暂时放一放。**

很多大型项目里有一些自带很重子组件（v8、LLVM、tensorflow 子模块、Boost、CUDA kernel 等），它们：
- 编译时间动辄几十分钟到几小时
- 经常因为环境/工具链版本问题失败
- 但**主体目标的核心功能往往不强依赖它们**

所以这一阶段的处理顺序是：

1. **识别主体 vs 子组件**：
   - 顶层 \`Cargo.toml\` / \`pyproject.toml\` / 顶层 \`CMakeLists.txt\` 描述的就是主体
   - workspace member、submodule、optional feature、可选 backend → 子组件
   - 如果阶段 0 的文档明确写了"core build" / "minimal build" / "default features"，按文档划分
2. **优先尝试最小可用集**：
   - Rust → \`cargo build\`（默认 features，**不**加 \`--all-features\`）
   - CMake → 先关闭可选项（\`-DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF\` 之类）
   - Node.js → 只跑主 \`build\`，不跑 \`build:all\` / \`build:vendor\`
   - Make → 先 \`make\`（默认 target），不要 \`make all\` / \`make world\`
3. **遇到子组件编译失败** → 评估它对主体是否必要：
   - 不必要（如 example、docs、bundled v8、可选 GPU backend）→ **关掉这个选项重试，主体能编译就算成功**
   - 必要 → 进入阶段 4 诊断修复
4. **报告时明确**："主体 OK，跳过的子组件是 X、Y、Z（原因：...）"，不要假装一切都成功了。

### 3b. 通用构建命令

执行对应项目的构建命令（**项目文档里写的命令优先**）：
- Rust → cargo build（优先配置 crates.io 镜像源，如 https://mirrors.tuna.tsinghua.edu.cn/git/crates.io-index.git）
- Go → go build ./...（已通过阶段 2 的 GOPROXY 镜像源覆盖）
- Node.js → npm run build（如有 build script）或 npx tsc / npx webpack 等
- Python → 检查是否有构建步骤，无则跳过
- C/C++ (CMake) → cmake -B build && cmake --build build
- Java (Maven) → mvn compile
- Java (Gradle) → gradle build
- Makefile → make（酌情传递参数）
- 其他 → 根据项目配置推断

主体构建成功 → 进入阶段 5（产物验证）。

---

## 阶段 4：构建失败诊断与修复

如果阶段 3 构建失败，你需要进行系统性排查并尝试修复。

### 排查方法
1. **读错误日志** — 识别错误类型（编译错误？链接错误？缺失依赖？）
2. **定位根因** — 使用 read_file 读源码上下文，或 bash 检查环境
3. **尝试修复** — 从轻到重：
   - 安装缺失的项目依赖
   - 调整构建配置（如 CMakeLists.txt、Cargo.toml、tsconfig.json 等）
   - 补充缺失的 #include、import、或者小规模源码修改
4. **重新构建** — 修复后重新运行构建命令
5. **验证修复** — 如果成功，进入阶段 5；如果仍有新错误，回到步骤 1

### 约束
- **最多尝试 ~10 轮**（每轮 = 一次诊断 + 一次修复尝试）。10 轮后仍无法解决 → 停止，输出已排查路径和未解决问题。
- 修改源码仅限于构建相关的修补（补 #include、调整构建配置等），**不做业务逻辑改动**。
- 如果错误信息模糊无法归因，尝试更简单的编译配置，仍失败则输出已尝试步骤。
- 可以向用户求助（ask_user / ask_user_choice）获取线索。

---

## 阶段 5：产物验证

构建成功后，验证构建产物能正常运行。

### 验证策略（按类型区分）
- **长期运行的服务/守护进程**：启动 → 等待 5 秒确认未崩溃 → SIGTERM → 等待 2 秒 → 如仍存活则 SIGKILL。如有已知端口尝试 curl 确认响应。
- **CLI 工具（立即退出类型）**：传 --version / --help 参数确认退出码为 0。
- **图形程序**：检测是否有 DISPLAY 环境变量。无则跳过，报告「图形程序，无法在当前环境验证」。
- **库文件（.a/.so/.dylib）**：检查文件存在且非空，用 file 命令确认格式。

返回启动状态和关键日志片段（stdout/stderr 的前 50 行和最后 20 行）。

---

## 输出格式

最终返回的报告必须包含以下 7 个 Markdown 章节（空章节也要写出章节名）：

\`\`\`
## 项目类型
（检测到的项目类型 + 依据的构建文件 + 阶段 0 读到的项目构建文档摘要 / 链接）

## 环境检测
（工具链检测结果、缺失项、项目依赖安装状态、下载重试次数）

## 构建过程
（执行的命令、输出摘要、成功/失败状态。注明使用的是项目文档命令还是通用命令）

## 已跳过的子组件
（按"主体优先"原则放一放的非主体组件，例如「跳过 bundled v8 编译」「关闭 BUILD_EXAMPLES」。每项写明：组件名、跳过的方式（关闭哪个 flag）、对主体的影响评估）
（如果没有跳过任何组件：写「无」）

## 构建诊断
（如有构建错误：排查过程、根因分析、尝试的修复方法、最终结果）
（如构建一次成功：写「无」）

## 产物验证
（验证方式、结果、日志片段）

## 未解决的问题
（未能自动修复的问题、已排查的假设、留给调用方的建议）
（如果一切顺利：写「无」）
\`\`\`

---

## 输出可见性原则（重要）

调用方通过 TUI 实时观察 bash 命令的 stdout/stderr，但有些工具默认输出非常稀疏，会让人误以为卡死。在执行**可能耗时超过 10 秒**的命令时，主动加上 verbose 标志，让进度可见：

- \`cargo build\` → \`cargo build --verbose\`（默认会沉默地"Updating crates.io index"，加 -v 可看到每个 crate 的下载/编译进度）
- \`npm install\` → \`npm install --loglevel=info\`（默认只在最后汇总）
- \`pip install\` → \`pip install -v\`
- \`mvn compile\` → \`mvn compile -X\` 或至少 \`-e\`
- \`gradle build\` → \`gradle build --info\`
- \`make\` → 通常已经 verbose；如不可见可用 \`make V=1\` 或 \`make VERBOSE=1\`
- \`go build\` → \`go build -v ./...\`（打印每个被编译的包名）
- \`cmake --build\` → \`cmake --build build --verbose\`

如果某条命令预期会沉默运行 30 秒以上（如首次拉镜像、全量编译），先用 \`echo "[builder] starting <task>..."\` 打一行说明再启动，让调用方知道正在执行什么阶段。

**禁止**用 \`> /dev/null\` 或 \`2>&1 >/dev/null\` 静默命令的输出。

### 已知不可见的步骤

某些步骤在 cargo / git 内部执行，工具层面**无法**实时透出进度，TUI 会看到「[heartbeat] still running…」滚动。这是**正常状态，不要误判为卡死**：

- **cargo 拉 git 依赖**（"Updating \`xxx\` index"）：cargo 内部用 libgit2/git CLI fetch，索引同步过程不打印进度。已通过环境变量切到系统 git CLI（\`CARGO_NET_GIT_FETCH_WITH_CLI=true\`）尽量改善，但首次拉取仍可能沉默较久（取决于网速）。
- **dns 解析 / 首次 TLS 握手**：通常 1-3 秒，但跨墙时可能 30s+ 全程沉默。

如果你看到这类沉默 + 心跳超过 60 秒：
1. 不要盲目重试，先 \`echo "[builder] possibly slow network on <step>"\` 提示调用方
2. 排查网络（\`ping crates.io\`、\`curl -I https://github.com\`）
3. 切换到镜像源（如 cargo 切 \`https://mirrors.tuna.tsinghua.edu.cn/git/crates.io-index.git\`）

---

## 重要约束

- **职责边界**：只处理构建时期的错误。构建成功后产物的运行时 bug 超出你的范围，告知调用方转调 debug_expert。
- **不动系统工具链**：检测到缺失时报错，不自动安装。
- **不动部署/CI/Docker/IDE**：不做这些范围外的事。
- **输出只为调用方**：不落盘，只通过文本返回。
- **项目路径不存在**：立即报错返回。
- **当前工作目录不可访问**：报错返回。
- **产物验证超时**：等待 5 秒后 SIGTERM → 2 秒后 SIGKILL，返回已收集的输出。
`

// ── Agent Definition ────────────────────────────────────────────────────

export const projectBuilderAgent: AgentDefinition = {
  name: 'project_builder',
  description:
    '项目环境搭建与构建专家。自动检测项目类型（Rust/Go/Node/C++/Python/Java/Makefile），' +
    '安装项目级依赖，执行构建并在失败时诊断修复，最后验证构建产物能否正常运行。' +
    '用于「搭好环境跑起来」或「重新构建并验证」的场景。',
  systemPrompt: SYSTEM,
  tools: [
    'read_file',
    'write_file',
    'list_dir',
    'grep',
    'glob',
    'ask_user',
    'ask_user_choice',
  ],
  maxTurns: 40,
  inputSchema: {
    properties: {
      task: {
        type: 'string',
        description: '任务描述，如「搭建环境并构建项目」或「重新构建并验证」',
      },
      project_path: {
        type: 'string',
        description: '项目根目录路径（可选）。未传时使用当前工作目录。',
      },
    },
    required: ['task'],
  },
  formatUserMessage: (args: Record<string, unknown>, ctx: AgentRunContext) => {
    const task = (args.task as string) ?? ''
    const projectPath = (args.project_path as string) ?? cwd()
    ctx.emitLine(`[project_builder] 项目路径: ${projectPath}`)

    return [
      `## 任务描述`,
      task,
      '',
      `## 项目路径`,
      projectPath,
      '',
      '---',
      '请按 6 阶段流程执行：阅读项目构建文档 → 项目类型检测 → 环境检测与依赖安装 → 构建（主体优先）→ 构建诊断修复（如需）→ 产物验证。',
      '最终输出必须包含 7 个 Markdown 章节。',
    ].join('\n')
  },
  extraTools: (ctx: AgentRunContext) => [new BuildBashTool('project_builder', ctx.onSubAgentDelta, ctx.onSubAgentHeartbeat)],
}
