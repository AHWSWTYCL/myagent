import fs from 'fs'
import os from 'os'
import path from 'path'

// ── 模型定义 ──────────────────────────────────────────────────────────────────

export interface ModelInfo {
  /** API 调用时用的模型名，如 "deepseek-v4-pro" */
  name: string
  /** 给人看的名称，如 "DeepSeek V4 Pro" */
  displayName: string
  /** 简短说明 */
  description: string
  /** 输入价格（cache miss），$/1M tokens */
  inputPrice: number
  /** 输出价格，$/1M tokens */
  outputPrice: number
  /** 并发限制 */
  concurrency: number
}

/** 默认模型：DeepSeek V4 Pro */
export const DEFAULT_MODEL = 'deepseek-v4-pro'

/**
 * 可用模型列表。
 * 价格参考：https://api-docs.deepseek.com/quick_start/pricing
 *
 * Pro vs Flash 核心差异：
 *   - Pro：价格约 Flash 的 3x，推理能力更强，适合复杂多步推理（planner、分析等）
 *   - Flash：速度快、便宜，适合简单任务、批量操作、记忆提取等
 *   - 两者都支持 1M 上下文、thinking mode、tool calls、JSON output
 */
const AVAILABLE_MODELS: ModelInfo[] = [
  {
    name: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    description: '旗舰模型，输入 $0.435/M，输出 $0.87/M，并发 500。最强推理能力，适合复杂多步任务',
    inputPrice: 0.435,
    outputPrice: 0.87,
    concurrency: 500,
  },
  {
    name: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    description: '快速模型，输入 $0.14/M，输出 $0.28/M，并发 2500。速度快、成本低，适合简单任务',
    inputPrice: 0.14,
    outputPrice: 0.28,
    concurrency: 2500,
  },
]

// ── 持久化 ────────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.myagent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'model-config.json')

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
    // 验证是否在可用列表中
    if (AVAILABLE_MODELS.some(m => m.name === model)) {
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
    console.error(`[model-config] 持久化失败: ${err}`)
  }
}

// ── 单例 ──────────────────────────────────────────────────────────────────────

class ModelConfig {
  private current: string

  constructor() {
    this.current = loadPersistedModel() ?? DEFAULT_MODEL
  }

  /** 获取当前模型名（API 调用用） */
  getCurrent(): string {
    return this.current
  }

  /** 切换模型，并持久化 */
  setCurrent(modelName: string): boolean {
    const info = AVAILABLE_MODELS.find(m => m.name === modelName)
    if (!info) return false
    this.current = info.name
    persistModel(this.current)
    return true
  }

  /** 获取所有可用模型 */
  list(): ModelInfo[] {
    return [...AVAILABLE_MODELS]
  }

  /** 查找模型信息 */
  find(modelName: string): ModelInfo | undefined {
    return AVAILABLE_MODELS.find(m => m.name === modelName)
  }

  /** 重置为默认模型 */
  reset(): void {
    this.current = DEFAULT_MODEL
    persistModel(this.current)
  }
}

export const modelConfig = new ModelConfig()
