import { createClient } from '../client.js'
import { readAllCategories } from './memory.js'

const RECALL_MODEL = 'claude-haiku-4-5'

const RECALL_SYSTEM_PROMPT = `你是一个记忆召回助手。你的任务是根据用户的当前 query，从历史记忆中筛选出最相关的部分。

## 规则
1. 仔细阅读所有历史记忆和用户的 query
2. 选出与当前 query 在语义上相关的记忆片段
3. 对内容重复或高度相似的记忆片段，合并为一条，保留最完整的表述，不要重复输出
4. 直接输出筛选后的记忆片段，保持原文，不要改写、总结或添加解释
5. 如果多条记忆连续相关，保持它们的原始顺序
6. 如果没有相关的记忆，输出空字符串（不要输出任何内容）
7. 不要添加任何额外的说明文字`

/**
 * 召回与当前 query 相关的记忆。
 * 使用一次轻量 LLM 调用来语义筛选，而非向量检索。
 *
 * @param query 用户的当前输入
 * @returns 相关的记忆文本片段，若无相关记忆则返回空字符串
 */
export async function recallRelevantMemory(query: string): Promise<string> {
  // 1. 读取所有记忆
  const allMemory = readAllCategories()
  const hasMemory = Object.values(allMemory).some(v => v.trim().length > 0)
  if (!hasMemory) {
    return ''
  }

  // 2. 将记忆格式化为带分类标题的文本
  const memoryText = Object.entries(allMemory)
    .filter(([_, content]) => content.trim())
    .map(([cat, content]) => `### ${cat}\n${content}`)
    .join('\n\n')

  // 3. 调用 LLM 筛选相关记忆（一次调用，无 tool loop）
  const client = createClient()
  try {
    const response = await client.messages.create({
      model: RECALL_MODEL,
      max_tokens: 2048,
      system: RECALL_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `## 当前用户 query\n${query}\n\n## 历史记忆\n${memoryText}\n\n请筛选出与当前 query 相关的记忆：`,
        },
      ],
    })

    const textBlock = response.content.find(b => b.type === 'text')
    const result = textBlock ? textBlock.text.trim() : ''

    return result
  } catch (err) {
    console.error(`[recall] Error: ${err}，回退到无记忆模式`)
    return ''
  }
}
