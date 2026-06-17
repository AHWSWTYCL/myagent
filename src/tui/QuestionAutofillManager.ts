import { createClient } from '../client.js'
import { modelConfig } from '../llm/model-config.js'
import type Anthropic from '@anthropic-ai/sdk'
import type { QuestionSuggestion } from './types.js'

/**
 * LLM 提问时的输入建议生成器。
 *
 * 当 LLM 调用 ask_user / ask_user_choice 时，
 * 用同一个模型做一个轻量 API 调用，猜用户最可能的回答。
 * 结果作为 ghost text 显示在输入框中。
 *
 * 设计意图：
 * - 不是 full sub-agent（太贵、太慢），只是一个单次 LLM API 调用
 * - 静默失败：API 错误或超时不应影响用户体验
 * - 无建议也静默：LLM 判断没有合理猜测时不做任何显示
 */
export class QuestionAutofillManager {
  private client: Anthropic
  private _enabled = false
  private debug = false

  constructor() {
    this.client = createClient()
  }

  get enabled(): boolean {
    return this._enabled
  }

  setEnabled(v: boolean): void {
    this._enabled = v
  }

  toggle(): boolean {
    this._enabled = !this._enabled
    return this._enabled
  }

  /**
   * 根据问题 + 对话上下文，生成 1 条最佳用户回答建议。
   * @returns 建议文本，无合适建议时返回 null
   */
  async generateSuggestion(prompt: string, contextMessages: string): Promise<QuestionSuggestion | null> {
    if (!this._enabled) return null

    try {
      const model = modelConfig.getCurrent()
      if (this.debug) process.stderr.write(`[autofill] calling ${model}...\n`)
      const response = await this.client.messages.create({
        model,
        max_tokens: 100,
        system: [
          '你是输入建议助手。根据用户正被提问的问题和对话上下文，生成 1 条最可能的用户回答。',
          '规则：',
          '- 只返回建议文本本身，不加引号、标点或任何解释',
          '- 不超过 50 字',
          '- 如果没有合理猜测，返回一个字面空字符串',
        ].join('\n'),
        messages: [{
          role: 'user',
          content: `问题：${prompt}\n\n对话上下文：\n${contextMessages}\n\n请给出1条最可能的用户回答：`,
        }],
      })

      const text = response.content
        .map(c => {
          if (c.type === 'text') return c.text
          return ''
        })
        .join('')
        .trim()

      if (this.debug) process.stderr.write(`[autofill] response: "${text.slice(0, 80)}"\n`)
      if (!text || text.length === 0) return null
      return { text }
    } catch (err) {
      // 静默失败 — 建议是增强功能，不应影响主流程
      process.stderr.write(`[autofill] API error: ${err}\n`)
      return null
    }
  }
}
