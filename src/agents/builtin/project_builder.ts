import { spawn } from 'child_process'
import { cwd } from 'process'
import { AgentDefinition, AgentRunContext } from '../definition.js'
import { Tool } from '../../tools/tool.js'

// ── 构建专用的 bash 工具（shadow 全局 bash，timeout 更长，流式输出） ────────

const BUILD_TIMEOUT_MS = 300_000     // 5 分钟
const KILL_GRACE_MS = 2_000          // SIGTERM 后 2 秒再 SIGKILL
const BUILD_MAX_OUTPUT_BYTES = 200_000  // 返回给 LLM 的最大字节数

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

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = (args.command ?? '') as string
    for (const { pattern, reason } of BLACKLIST) {
      if (pattern.test(command)) return `[BLOCKED] ${reason}\nCommand: ${command}`
    }
    return runStreamingBash(command, this.agentName, this.onDelta)
  }
}

function runStreamingBash(
  command: string,
  agentName: string,
  onDelta?: (name: string, delta: string) => void,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let buffer = ''
    let truncatedBytes = 0
    const append = (chunk: string) => {
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

    let timedOut = false
    let killTimer: NodeJS.Timeout | null = null
    const timeout = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already dead */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already dead */ }
      }, KILL_GRACE_MS)
    }, BUILD_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      resolve(`Error spawning bash: ${err.message}\nCommand: ${command}`)
    })

    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)

      const tail = tailLines(buffer, 200)
      const tailNote = tail.truncated
        ? `\n\n...（输出已截断，原始 ${tail.totalLines} 行，仅保留末尾 200 行）`
        : ''
      const bytesNote = truncatedBytes > 0
        ? `\n\n...（${truncatedBytes} 字节因超出 ${BUILD_MAX_OUTPUT_BYTES} 上限被丢弃）`
        : ''

      if (timedOut) {
        resolve(`Timed out after ${BUILD_TIMEOUT_MS / 1000}s (signal=${signal ?? 'SIGTERM'}):\n${tail.text}${tailNote}${bytesNote}`)
        return
      }
      if (code === 0) {
        resolve(tail.text || '(no output)')
        return
      }
      resolve(`Exit code ${code ?? '?'}${signal ? ` (signal ${signal})` : ''}:\n${tail.text || '(no output)'}${tailNote}${bytesNote}`)
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

你按以下 5 个阶段依次执行，**不要跳过任何阶段**。

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
- Node.js → npm install / yarn install / pnpm install（根据 lockfile 选择）
- Rust → 不自动装依赖（cargo build 会自动下载）
- Go → go mod download
- Python → pip install -r requirements.txt 或 pip install -e .
- Java → mvn dependency:resolve 或 gradle dependencies
- C/C++ → 酌情安装子依赖（如 apt-get install libxxx-dev）
- 其他 → 根据项目文档判断

安装失败时，捕获错误信息，尝试分析根因（网络问题？版本冲突？权限？）并报告。

---

## 阶段 3：构建/编译

执行对应项目的构建命令：
- Rust → cargo build
- Go → go build ./...
- Node.js → npm run build（如有 build script）或 npx tsc / npx webpack 等
- Python → 检查是否有构建步骤，无则跳过
- C/C++ (CMake) → cmake -B build && cmake --build build
- Java (Maven) → mvn compile
- Java (Gradle) → gradle build
- Makefile → make（酌情传递参数）
- 其他 → 根据项目配置推断

构建成功 → 进入阶段 5（产物验证）。

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

最终返回的报告必须包含以下 6 个 Markdown 章节（空章节也要写出章节名）：

\`\`\`
## 项目类型
（检测到的项目类型 + 依据的构建文件）

## 环境检测
（工具链检测结果、缺失项、项目依赖安装状态）

## 构建过程
（执行的命令、输出摘要、成功/失败状态）

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
      '请按 5 阶段流程执行：项目类型检测 → 环境检测与依赖安装 → 构建 → 构建诊断修复（如需）→ 产物验证。',
      '最终输出必须包含 6 个 Markdown 章节。',
    ].join('\n')
  },
  extraTools: (ctx: AgentRunContext) => [new BuildBashTool('project_builder', ctx.onSubAgentDelta)],
}
