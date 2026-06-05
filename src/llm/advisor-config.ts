import fs from 'fs'
import os from 'os'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { loadAdvisorSettings, loadClaudeSettings } from '../config.js'

// ── Advisor 模型定义 ──────────────────────────────────────────────────────────

export interface AdvisorModelInfo {
  /** API 调用时用的模型名，如 "claude-opus-4-7" */
  name: string
  /** 给人看的名称，如 "Claude Opus 4.7" */
  displayName: string
  /** 简短说明 */
  description: string
}

/** 默认 advisor 模型：Sonnet（成本低、速度快） */
export const DEFAULT_ADVISOR_MODEL = 'claude-sonnet-4-6'

export const ADVISOR_MODELS: AdvisorModelInfo[] = [
  {
    name: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    description: '快速、高性价比，适合日常顾问咨询',
  },
  {
    name: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    description: '最强推理能力，适合深度分析和复杂决策',
  },
]

// ── 持久化 ────────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.myagent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'advisor-model-config.json')

function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

function loadPersistedModel(): string | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const data = JSON.parse(raw)
    const model = data.currentModel
    if (ADVISOR_MODELS.some(m => m.name === model)) {
      return model
    }
    return null
  } catch {
    return null
  }
}

function persistModel(model: string): void {
  try {
    ensureDir()
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ currentModel: model }, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[advisor-config] 持久化失败: ${err}`)
  }
}

// ── Client 创建 ───────────────────────────────────────────────────────────────

/**
 * 创建 advisor 专用的 Anthropic client。
 * 使用原生 Anthropic API（非 DeepSeek 兼容端点）。
 * 失败返回 null（用户可能没有 Anthropic Key，此时 advisor 不可用但不影响主 agent）。
 */
function createAdvisorClient(): Anthropic | null {
  try {
    const { authToken, apiKey, baseURL } = loadAdvisorSettings()
    
      const token = authToken ?? apiKey
      if (!token) {
        throw new Error('No auth token or API key available')
      }
    
      return new Anthropic({
        apiKey: null,
        authToken: null,
        ...(baseURL ? { baseURL } : {}),
        defaultHeaders: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'claude-cli/1.0.0 (myagent- advisor)',
        },
      })
  } catch (err) {
    console.error(`[advisor-config] Claude 原生 client 创建失败: ${err}`)
    console.error(`[advisor-config] advisor agent 将不可用。请确保 ~/.claude/settings.json 中有 ANTHROPIC_API_KEY。`)
    return null
  }
}

// ── 单例 ──────────────────────────────────────────────────────────────────────

class AdvisorConfig {
  private current: string
  /** 启动时创建的 Claude client（无 baseURL 重定向，走原生 API）。null 表示不可用。 */
  readonly client: Anthropic | null

  constructor() {
    this.current = loadPersistedModel() ?? DEFAULT_ADVISOR_MODEL
    this.client = createAdvisorClient()
  }

  /** advisor 是否可用（是否有原生 Claude API Key） */
  get available(): boolean {
    return this.client !== null
  }

  /** 获取当前 advisor 模型名（API 调用用） */
  getCurrent(): string {
    return this.current
  }

  /** 切换模型，并持久化 */
  setCurrent(modelName: string): boolean {
    const info = ADVISOR_MODELS.find(m => m.name === modelName)
    if (!info) return false
    this.current = info.name
    persistModel(this.current)
    return true
  }

  /** 获取所有可用 advisor 模型 */
  list(): AdvisorModelInfo[] {
    return [...ADVISOR_MODELS]
  }

  /** 查找模型信息 */
  find(modelName: string): AdvisorModelInfo | undefined {
    return ADVISOR_MODELS.find(m => m.name === modelName)
  }

  /** 重置为默认模型 */
  reset(): void {
    this.current = DEFAULT_ADVISOR_MODEL
    persistModel(this.current)
  }
}

export const advisorConfig = new AdvisorConfig()
