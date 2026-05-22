import { Hook, HookContext, HookResult } from './hook.js'
import type { AutoPermissionAgent } from './autopermissionagent.js'
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
    // 文件不存在或解析失败，返回空配置（不影响正常运行）
    console.log('[permission] permissions.json not found, skipping rule check')
    return { blacklist: [], whitelist: [] }
  }
}

// ── 提取工具的"关键参数"用于规则匹配 ─────────────────────────────────────────
function extractSubject(toolName: string, args: Record<string, string>): string | null {
  switch (toolName) {
    case 'bash':       return args.command ?? null
    case 'write_file': return args.path ?? null
    case 'web_fetch':  return args.url ?? null
    default:           return null
  }
}

// ── 规则匹配 ──────────────────────────────────────────────────────────────────
function matchesRule(rule: PermissionRule, toolName: string, subject: string): boolean {
  if (rule.tool !== '*' && rule.tool !== toolName) return false
  try {
    return new RegExp(rule.pattern, 'i').test(subject)
  } catch {
    console.log(`[permission] invalid regex pattern: ${rule.pattern}`)
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

  constructor(private askPermission: (prompt: string) => Promise<PermissionAnswer>) {
    this.config = loadPermissionsConfig()
    console.log(
      `[permission] loaded rules — blacklist: ${this.config.blacklist.length}, whitelist: ${this.config.whitelist.length}`
    )
  }

  setAutoMode(enabled: boolean, agent?: AutoPermissionAgent) {
    this.autoMode = enabled
    if (agent) this.autoAgent = agent
  }

  get isAutoMode() {
    return this.autoMode
  }

  async onToolCall(ctx: HookContext): Promise<HookResult> {
    const dangerousTools = ['write_file', 'bash', 'web_fetch']
    if (!dangerousTools.includes(ctx.toolName)) {
      return { action: 'continue' }
    }

    const args = ctx.toolInput as Record<string, string>
    const subject = extractSubject(ctx.toolName, args)
    const key = ctx.toolName === 'bash' ? `bash:${args.command}` : `${ctx.toolName}:${subject}`

    const prompt =
      ctx.toolName === 'bash'
        ? `Run bash: $ ${args.command}`
        : ctx.toolName === 'web_fetch'
        ? `Fetch URL: ${args.url}`
        : `Write file: ${args.path}`

    // ── 1. 黑名单检查（最高优先级，硬性拒绝）────────────────────────────────
    if (subject !== null) {
      for (const rule of this.config.blacklist) {
        if (matchesRule(rule, ctx.toolName, subject)) {
          const reason = rule.reason ?? 'Blocked by blacklist rule'
          console.log(`[permission] 🚫 blacklist hit — ${prompt} | reason: ${reason}`)
          return { action: 'block', reason }
        }
      }
    }

    // ── 2. 白名单检查（硬性放行，跳过后续所有检查）──────────────────────────
    if (subject !== null) {
      for (const rule of this.config.whitelist) {
        if (matchesRule(rule, ctx.toolName, subject)) {
          console.log(`[permission] ✅ whitelist hit — ${prompt}`)
          return { action: 'continue' }
        }
      }
    }

    // ── 3. session 缓存命中，直接放行 ────────────────────────────────────────
    if (this.sessionAllowed.has(key)) {
      console.log(`[permission] ✅ session cache hit — ${prompt}`)
      return { action: 'continue' }
    }

    // ── 4. auto mode：交给 AI agent 决策 ─────────────────────────────────────
    if (this.autoMode && this.autoAgent) {
      console.log(`[permission] 🤖 auto mode — asking agent: ${prompt}`)
      const answer = await this.autoAgent.decide(prompt)
      if (answer === 'no') {
        console.log(`[permission] ❌ agent denied — ${prompt}`)
        return { action: 'block', reason: 'Auto mode: agent denied permission' }
      }
      this.sessionAllowed.add(key)
      console.log(`[permission] ✅ agent allowed — ${prompt}`)
      return { action: 'continue' }
    }

    // ── 5. 手动模式：询问用户 ─────────────────────────────────────────────────
    console.log(`[permission] ❓ asking user — ${prompt}`)
    const answer = await this.askPermission(prompt)
    console.log(`[permission] user answered: ${answer} — ${prompt}`)

    if (answer === 'yes') {
      return { action: 'continue' }
    }

    if (answer === 'session') {
      this.sessionAllowed.add(key)
      console.log(`[permission] 📌 added to session cache — ${key}`)
      return { action: 'continue' }
    }

    return { action: 'block', reason: 'User denied permission' }
  }

  get sessionAllowedKeys(): string[] {
    return Array.from(this.sessionAllowed)
  }
}
