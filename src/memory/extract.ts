import { createClient } from '../client.js'
import { readCategory, writeCategory, MemoryCategory } from './memory.js'

const EXTRACT_MODEL = 'claude-haiku-4-5'

const EXTRACT_SYSTEM_PROMPT = `你是记忆抽取助手。从一轮对话中提取值得长期记住的信息。

## 必须记录的触发信号（命中其一才记）
1. 纠正类（最重要）— 用户用否定/纠正语气：
   "不要"、"别"、"错了"、"stop"、"不是这样"、"不对"、"我不喜欢"
2. 偏好类 — 用户表达个人/项目偏好：
   "我喜欢"、"我习惯"、"我们都用"、"默认用"、"风格是"、"项目里"
3. 显式记忆 — 用户明确要求：
   "记住"、"记一下"、"下次注意"、"以后都"
4. 事实声明 — 用户身份/项目背景：
   "我是…(职业/角色)"、"我们团队…"、"这个项目…(非代码事实)"
5. 外部引用 — 文档/链接/资源/ticket：
   URL、issue 号、外部系统名（Linear/Jira/Slack 频道等）

## 严禁记录
- 普通技术问答内容（"怎么实现 X"、"读一下这个文件"、"修一下 bug"）
- 从代码或 git 可读取的事实（用什么框架、有哪些文件、最近改了啥）
- 临时调试信息、当前任务进度、本次修改的细节
- 工具调用结果

## 分类
- profile: 用户身份、职业、技术栈、长期偏好
- project: 当前项目的非代码事实（决策动机、外部约束、团队约定）
- feedback: 用户对你工作方式的纠正、评价、风格偏好
- reference: 外部资源、链接、ticket、文档系统

## 输出格式
若有值得记录的信息，每条一行，严格格式为：
[category] content

要求：
- content 简洁（≤2 行），保留 user 原话的关键语气词
- 一行一条，不要 markdown 列表标记
- category 只能是 profile/project/feedback/reference 之一

若无任何值得记录的信息，仅输出：
NONE`

const VALID_CATEGORIES = new Set<MemoryCategory>(['profile', 'project', 'feedback', 'reference'])

export interface ExtractedMemory {
  category: MemoryCategory
  content: string
}

/**
 * 从单个 turn 中抽取值得记录的信息。
 * 只看本 turn 的 user/agent 两条消息，成本可控、信号纯净。
 */
export async function extractMemoryFromTurn(
  userInput: string,
  agentResponse: string,
): Promise<ExtractedMemory[]> {
  if (!userInput.trim()) return []

  const client = createClient()
  try {
    const response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 512,
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `## user\n${userInput}\n\n## agent\n${agentResponse || '(无文本回复)'}\n\n请按规则抽取：`,
        },
      ],
    })

    const textBlock = response.content.find(b => b.type === 'text')
    const raw = textBlock ? textBlock.text.trim() : ''
    if (!raw || raw === 'NONE') return []

    const results: ExtractedMemory[] = []
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim()
      if (!line || line === 'NONE') continue
      const match = line.match(/^\[(profile|project|feedback|reference)\]\s*(.+)$/i)
      if (!match) continue
      const cat = match[1].toLowerCase() as MemoryCategory
      if (!VALID_CATEGORIES.has(cat)) continue
      results.push({ category: cat, content: match[2].trim() })
    }
    return results
  } catch (err) {
    console.error(`[extract] Error: ${err}`)
    return []
  }
}

/** 把抽取出的记忆追加到对应分类，去重。返回新增条数。 */
export function appendMemories(items: ExtractedMemory[]): number {
  let added = 0
  for (const item of items) {
    const existing = readCategory(item.category)
    const lines = existing
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))

    const newEntry = `- ${item.content}`
    if (lines.includes(newEntry)) continue

    lines.push(newEntry)
    writeCategory(item.category, lines.join('\n') + '\n')
    added++
  }
  return added
}
