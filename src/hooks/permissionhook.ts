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

// ── PermissionHook ────────────────────────────────────────────────────────────
export class PermissionHook implements Hook {
  name = 'PermissionHook'

  private sessionAllowed: Set<string> = new Set()
  private autoMode = false
  private autoAgent: AutoPermissionAgent | null = null
  private config: PermissionsConfig
  private toolRegistrar: ToolRegistrar

  constructor(
    private askPermission: (prompt: string) => Promise<PermissionAnswer>,
    toolRegistrar: ToolRegistrar,
  ) {
    this.config = loadPermissionsConfig()
    this.toolRegistrar = toolRegistrar
  }

  setAutoMode(enabled: boolean, agent?: AutoPermissionAgent) {
    this.autoMode = enabled
    if (agent) this.autoAgent = agent
  }

  get isAutoMode() {
    return this.autoMode
  }

  async onToolCall(ctx: HookContext): Promise<HookResult> {
    const args = ctx.toolInput as Record<string, string>
    const subject = extractSubject(ctx.toolName, args)
    const key = ctx.toolName === 'bash'
      ? `bash:${args.command}`
      : `${ctx.toolName}:${subject}`

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

    // ── 3. session 缓存命中，直接放行 ────────────────────────────────────────
    if (this.sessionAllowed.has(key)) {
      return { action: 'continue' }
    }

    // ── 4. 工具自身的权限检查 ────────────────────────────────────────────────
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

    // ── 5. auto mode：交给 AI agent 决策 ─────────────────────────────────────
    if (this.autoMode && this.autoAgent) {
      const answer = await this.autoAgent.decide(prompt)
      if (answer === 'no') {
        // 拒绝时让用户确认
        const userAnswer = await this.askPermission(`[Auto mode denied] ${prompt}`)
        if (userAnswer === 'session') {
          this.sessionAllowed.add(key)
          return { action: 'continue' }
        }
        if (userAnswer === 'yes') return { action: 'continue' }
        return { action: 'block', reason: 'User denied permission' }
      }
      // 授权成功 → 静默放行
      this.sessionAllowed.add(key)
      return { action: 'continue' }
    }

    // ── 6. 手动模式：询问用户 ─────────────────────────────────────────────────
    const answer = await this.askPermission(prompt)
    if (answer === 'yes') {
      return { action: 'continue' }
    }
    if (answer === 'session') {
      this.sessionAllowed.add(key)
      return { action: 'continue' }
    }
    return { action: 'block', reason: 'User denied permission' }
  }

  get sessionAllowedKeys(): string[] {
    return Array.from(this.sessionAllowed)
  }
}
