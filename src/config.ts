import fs from 'fs'
import os from 'os'
import path from 'path'

export interface ClaudeSettings {
  authToken?: string
  apiKey?: string
  baseURL?: string
}

/**
 * 从环境变量构建配置（CI / GitHub Actions 模式优先）。
 * 返回 null 表示环境变量未设置，需要走文件模式。
 */
function tryEnvConfig(): ClaudeSettings | null {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  return {
    authToken: apiKey,  // API Key 同时作为 Bearer token
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  }
}

/**
 * 主 agent 的 LLM 配置。
 *
 * 优先级：
 *   1. 环境变量 ANTHROPIC_API_KEY（CI / GitHub Actions）
 *   2. ~/.claude/settings-using-deepseek.json（本地 DeepSeek 兼容）
 */
export function loadClaudeSettings(): ClaudeSettings {
  const envCfg = tryEnvConfig()
  if (envCfg) return envCfg

  const settingsPath = path.join(os.homedir(), '.claude', 'settings-using-deepseek.json')
  if (!fs.existsSync(settingsPath)) {
    throw new Error(
      `LLM 配置缺失：请设置环境变量 ANTHROPIC_API_KEY，或在 ${settingsPath} 中配置`
    )
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
 * Advisor agent 的 LLM 配置（原生 Claude 模型）。
 *
 * 优先级：
 *   1. 环境变量 ANTHROPIC_API_KEY（CI / GitHub Actions）
 *   2. ~/.claude/settings.json（本地 Claude Code）
 */
export function loadAdvisorSettings(): AdvisorSettings {
  const envCfg = tryEnvConfig()
  if (envCfg) return envCfg

  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    throw new Error(
      `Advisor LLM 配置缺失：请设置环境变量 ANTHROPIC_API_KEY，或在 ${settingsPath} 中配置`
    )
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
