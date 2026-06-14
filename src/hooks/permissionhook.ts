import { Hook, HookContext, HookResult } from './hook.js'
import type { AutoPermissionAgent } from './autopermissionagent.js'
import type { ToolRegistrar } from '../tools/toolregistrar.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

export type PermissionAnswer = 'yes' | 'session' | 'no'

// ── 黑白名单配置结构 ──────────────────────────────────────────────────────────
interface PermissionRule {
  tool: string      // 工具名，如 'bash'、'write_file'，'*' 表示所有工具
  pattern: string   // 正则，匹配工具的关键参数
  reason?: string   // 仅黑名单使用，拒绝时展示给用户
}

interface PermissionsConfig {
  blacklist: PermissionRule[]
  whitelist: PermissionRule[]
}

// ── 加载配置文件 ──────────────────────────────────────────────────────────────
function loadPermissionsConfig(): PermissionsConfig {
  const configPath = path.join(os.homedir(), '.myagent', 'permissions.json')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as PermissionsConfig
  } catch {
    return { blacklist: [], whitelist: [] }
  }
}

// ── 提取工具的"关键参数"用于规则匹配 ─────────────────────────────────────────
function extractSubject(toolName: string, args: Record<string, string>): string | null {
  switch (toolName) {
    case 'bash':       return args.command ?? null
    case 'write_file': return args.path ?? null
    case 'web_fetch':  return args.url ?? null
    case 'read_file':  return args.path ?? null
    case 'list_dir':   return args.path ?? null
    case 'grep':       return args.pattern ?? null
    default:           return null
  }
}

// ── 规则匹配 ──────────────────────────────────────────────────────────────────
function matchesRule(rule: PermissionRule, toolName: string, subject: string): boolean {
  if (rule.tool !== '*' && rule.tool !== toolName) return false
  try {
    return new RegExp(rule.pattern, 'i').test(subject)
  } catch {
    return false
  }
}

// ── VSCode 扩展环境检测 ──────────────────────────────────────────────────────
const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file'])
const VSCODE_TOOLS_PREFIX = 'vscode__'

// ── 智能缓存 key 生成 ──────────────────────────────────────────────────────────
// 同类操作共享同一个缓存 key，避免反复授权。
// 例如：bash:npm install → 匹配 npm install express / npm install -D typescript
//       write:src/       → 匹配 src/foo.ts / src/components/bar.tsx
const CACHE_TTL_MS = 30 * 60 * 1000  // 30 分钟过期

function buildCacheKey(toolName: string, args: Record<string, string>): string {
  switch (toolName) {
    case 'bash': {
      const cmd = (args.command ?? '').trim()
      // 取前两个词作为缓存 key（如 "npm install", "git clone", "cargo build"）
      const words = cmd.split(/\s+/)
      if (words.length >= 2) return `bash:${words[0]} ${words[1]}`
      if (words.length === 1) return `bash:${words[0]}`
      return `bash:`
    }
    case 'write_file': {
      const p = (args.path ?? '').trim()
      // 取目录前缀（上一级目录）作为缓存 key
      const dir = p.includes('/') ? p.replace(/\/[^/]*$/, '/') : './'
      return `write:${dir}`
    }
    case 'web_fetch': {
      const url = (args.url ?? '').trim()
      try {
        const hostname = new URL(url).hostname
        return `fetch:${hostname}`
      } catch {
        return `fetch:${url.slice(0, 30)}`
      }
    }
    // 其他工具用精确匹配
    default: {
      const subject = extractSubject(toolName, args)
      return `${toolName}:${subject ?? ''}`
    }
  }
}

// 清理过期的缓存条目
function cleanExpiredCache(cache: Map<string, number>): void {
  const now = Date.now()
  for (const [key, expiry] of cache) {
    if (now >= expiry) cache.delete(key)
  }
}

// ── Plan mode 下允许的工具（只读探索 + 计划 + 用户交互 + 团队协作）─────────
const PLAN_MODE_SAFE_TOOLS = new Set([
  'read_file',
  'list_dir',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
  'ask_user',
  'ask_user_choice',
  'memory',
  'use_skill',
  'invoke_skill',
  'todo_plan',
  'todo_update',
  'enter_plan_mode',
  'exit_plan_mode',
  'task',
  'skill_write',
  'agent',
  'send_mail',
  'check_mail',
  'create_team',
  'schedule_task',
  'start_teammate',
  'git_worktree',
  'weather__get_weather',
  'weather__list_cities',
])
export class PermissionHook implements Hook {
  name = 'PermissionHook'

  // Map<key, expiryTimestamp>
  private sessionAllowed: Map<string, number> = new Map()
  private lastCleanup = 0
  private mode: 'default' | 'auto' | 'plan' = 'auto'
  private autoAgent: AutoPermissionAgent | null = null
  private config: PermissionsConfig
  private toolRegistrar: ToolRegistrar
  private vscodeChecker: (() => boolean) | null = null

  constructor(
    private askPermission: (prompt: string) => Promise<PermissionAnswer>,
    toolRegistrar: ToolRegistrar,
  ) {
    this.config = loadPermissionsConfig()
    this.toolRegistrar = toolRegistrar
  }

  setMode(mode: 'default' | 'auto' | 'plan', agent?: AutoPermissionAgent | null) {
    this.mode = mode
    if (agent !== undefined) this.autoAgent = agent
  }

  /** 注入 VSCode 连接状态检查器。由 bootstrap.ts 在 mcpManager 就绪后调用。 */
  setVSCodeChecker(fn: () => boolean) {
    this.vscodeChecker = fn
  }

  get isAutoMode() {
    return this.mode === 'auto'
  }

  get isPlanMode() {
    return this.mode === 'plan'
  }

  async onToolCall(ctx: HookContext): Promise<HookResult> {
    const args = ctx.toolInput as Record<string, string>
    const subject = extractSubject(ctx.toolName, args)
    const key = buildCacheKey(ctx.toolName, args)

    // 定期清理过期缓存
    const now = Date.now()
    if (now - this.lastCleanup > 60_000) {
      cleanExpiredCache(this.sessionAllowed)
      this.lastCleanup = now
    }

    // ── 1. 黑名单检查（最高优先级，硬性拒绝）────────────────────────────────
    if (subject !== null) {
      for (const rule of this.config.blacklist) {
        if (matchesRule(rule, ctx.toolName, subject)) {
          const reason = rule.reason ?? 'Blocked by blacklist rule'
          return { action: 'block', reason }
        }
      }
    }

    // ── 2. 白名单检查（硬性放行，跳过后续所有检查）──────────────────────────
    if (subject !== null) {
      for (const rule of this.config.whitelist) {
        if (matchesRule(rule, ctx.toolName, subject)) {
          return { action: 'continue' }
        }
      }
    }

    // ── 3. plan mode 检查：只允许只读/探索/计划类工具 ─────────────────────
    if (this.mode === 'plan') {
      if (!PLAN_MODE_SAFE_TOOLS.has(ctx.toolName)) {
        return { action: 'block', reason: `Plan mode: tool "${ctx.toolName}" is not allowed. Only exploration and planning tools are permitted.` }
      }
      // 即使是安全工具，在 plan mode 下静默放行（不弹窗问用户）
      return { action: 'continue' }
    }

    // ── 4. session 缓存命中（检查过期时间），直接放行 ────────────────────────
    const expiry = this.sessionAllowed.get(key)
    if (expiry !== undefined && now < expiry) {
      return { action: 'continue' }
    }

    // ── 5. VSCode 扩展环境：文件编辑和 VSCode 工具跳过 TUI 授权 ──────────
    // VSCode 扩展已有 diff 审批机制（onBeforeEdit → showDiffInteractive），
    // 无需在 TUI 重复询问。VSCode 内部工具（vscode__*）由扩展自身管理。
    //
    // ⚠️ FILE_EDIT_TOOLS 必须与 bootstrap.ts 中注入 onBeforeEdit 的工具集
    // 保持一致。此处只绕过 TUI 弹窗，tool.checkPermission（Step 6）仍生效。
    // auto mode 下此处提前放行也可减少一次 auto agent 调用。
    if (this.vscodeChecker?.() && (FILE_EDIT_TOOLS.has(ctx.toolName) || ctx.toolName.startsWith(VSCODE_TOOLS_PREFIX))) {
      return { action: 'continue' }
    }

    // ── 6. 工具自身的权限检查 ────────────────────────────────────────────────
    const tool = this.toolRegistrar.getTool(ctx.toolName)
    if (tool) {
      const toolResult = await tool.checkPermission(args)
      if (toolResult.action === 'continue') {
        // 工具说安全 → 直接放行，跳过 auto/manual 决策
        return { action: 'continue' }
      }
      if (toolResult.action === 'block') {
        return { action: 'block', reason: toolResult.reason }
      }
      // toolResult.action === 'defer' → 继续往下走
    }

    // 构建给用户的提示
    const prompt =
      ctx.toolName === 'bash'
        ? `Run bash: $ ${args.command}`
        : ctx.toolName === 'web_fetch'
        ? `Fetch URL: ${args.url}`
        : ctx.toolName === 'write_file'
        ? `Write file: ${args.path}`
        : `${ctx.toolName}: ${JSON.stringify(args)}`

    // ── 7. auto mode：交给 AI agent 决策 ─────────────────────────────────────
    // 注意：auto mode 下 haiku 说了算，拒绝时直接 block，不回退问用户。
    // 用户如果不想让 AI 决策，可以关闭 auto mode（Shift+Tab 切换）。
    if (this.mode === 'auto' && this.autoAgent) {
      const answer = await this.autoAgent.decide(prompt)
      if (answer === 'no') {
        return { action: 'block', reason: 'Auto mode denied' }
      }
      // 授权成功 → 静默放行（缓存 30 分钟，同类操作不再问）
      this.sessionAllowed.set(key, now + CACHE_TTL_MS)
      return { action: 'continue' }
    }

    // ── 8. 手动模式：询问用户 ─────────────────────────────────────────────────
    const answer = await this.askPermission(prompt)
    if (answer === 'yes') {
      return { action: 'continue' }
    }
    if (answer === 'session') {
      // 用户选择 "本次会话允许" → 缓存 30 分钟
      this.sessionAllowed.set(key, now + CACHE_TTL_MS)
      return { action: 'continue' }
    }
    return { action: 'block', reason: 'User denied permission' }
  }

  get sessionAllowedKeys(): string[] {
    return Array.from(this.sessionAllowed.keys())
  }
}
