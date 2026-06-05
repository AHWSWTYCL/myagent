import fs from 'fs'
import os from 'os'
import path from 'path'

export interface ClaudeSettings {
  authToken?: string
  apiKey?: string
  baseURL?: string
}

export function loadClaudeSettings(): ClaudeSettings {
  // const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  const settingsPath = path.join(os.homedir(), '.claude', 'settings-using-deepseek.json')
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`settings.json not found at ${settingsPath}`)
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8')
  const settings = JSON.parse(raw)
  const env = settings.env ?? {}

  const authToken = env.ANTHROPIC_AUTH_TOKEN
  const apiKey = env.ANTHROPIC_API_KEY
  const baseURL = env.ANTHROPIC_BASE_URL

  if (!authToken && !apiKey) {
    throw new Error(
      'Neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY found in ~/.claude/settings.json env',
    )
  }

  return { authToken, apiKey, baseURL }
}

// ── Advisor settings（从标准 Claude Code settings.json 读 Anthropic 原生 API） ──

export interface AdvisorSettings {
   authToken?: string
  apiKey?: string
  baseURL?: string
}

/**
 * 从 ~/.claude/settings.json 加载 Anthropic 原生 API Key。
 * 与 loadClaudeSettings() 不同：这个专门用于 advisor agent（原生 Claude 模型），
 * 读的是标准 settings.json 而非 DeepSeek 的兼容配置。
 */
export function loadAdvisorSettings(): AdvisorSettings {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  // const settingsPath = path.join(os.homedir(), '.claude', 'settings-using-deepseek.json')
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`settings.json not found at ${settingsPath}`)
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8')
  const settings = JSON.parse(raw)
  const env = settings.env ?? {}

  const authToken = env.ANTHROPIC_AUTH_TOKEN
  const apiKey = env.ANTHROPIC_API_KEY
  const baseURL = env.ANTHROPIC_BASE_URL

  if (!authToken && !apiKey) {
    throw new Error(
      'Neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY found in ~/.claude/settings.json env',
    )
  }

  return { authToken, apiKey, baseURL }
}
