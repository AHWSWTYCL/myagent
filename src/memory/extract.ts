import { createClient } from '../client.js'
import { readCategory, writeCategory, MemoryCategory } from './memory.js'

const MAX_ENTRIES_PER_CATEGORY = 50

/** 归一化文本：转小写、去标点符号和空格，用于模糊比较 */
function normalizeText(text: string): string {
  const withoutPrefix = text.replace(/^-\s*/, '')
  return withoutPrefix
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, '')
    .trim()
}

/** 判断两条记忆是否"足够相似"（归一化后相等，或一方包含另一方）。
 * 语义层面的去重交给 consolidation LLM 处理。 */
function isSimilar(a: string, b: string): boolean {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // 一方包含另一方（处理措辞微调："不喜欢冗长输出" ≈ "不喜欢冗长的输出"）
  if (na.includes(nb) || nb.includes(na)) return true
  return false
}

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

/** 把抽取出的记忆追加到对应分类，去重（精确匹配 + 模糊匹配）。返回新增条数。 */
export function appendMemories(items: ExtractedMemory[]): number {
  let added = 0
  for (const item of items) {
    const category = item.category
    const existing = readCategory(category)
    const lines = existing
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))

    const newEntry = `- ${item.content}`

    // 第一道防御：精确匹配
    if (lines.includes(newEntry)) continue

    // 第二道防御：模糊匹配（归一化后相同或包含）
    const isDuplicate = lines.some(existingLine => isSimilar(existingLine, newEntry))
    if (isDuplicate) continue

    lines.push(newEntry)
    writeCategory(category, lines.join('\n') + '\n')
    added++

    // 定期压缩：当条目超过上限时，异步触发 LLM 合并
    if (lines.length > MAX_ENTRIES_PER_CATEGORY) {
      consolidateCategory(category).catch(err =>
        console.error(`[extract] consolidate ${category} failed:`, err),
      )
    }
  }
  return added
}

/** 对某个分类做 LLM 批量合并：将语义相似的记忆合并为一条，保留最完整表述。 */
async function consolidateCategory(category: MemoryCategory): Promise<void> {
  const raw = readCategory(category)
  const entries = raw.split('\n').filter(l => l.trim().startsWith('- '))
  if (entries.length <= MAX_ENTRIES_PER_CATEGORY) return

  const client = createClient()
  try {
    const response = await client.messages.create({
      model: EXTRACT_MODEL,
      max_tokens: 2048,
      system: `你是记忆合并助手。将语义重复或高度相似的记忆条目合并为一条，保留最完整的表述。
要求：
- 对于每条输出，保持 "- content" 格式
- 合并后的内容必须涵盖所有原文的关键信息，去掉修饰词
- 直接输出合并后的条目列表，每行一条，不要任何解释文字
- 如果所有条目都很独特无需合并，原样输出`,
      messages: [
        {
          role: 'user',
          content: `请合并以下 ${category} 分类中语义重复的记忆条目（共 ${entries.length} 条），输出精简后的列表：\n\n${entries.join('\n')}`,
        },
      ],
    })

    const textBlock = response.content.find(b => b.type === 'text')
    const result = textBlock?.text.trim()
    if (!result) return

    // 只保留符合 "- content" 格式的行
    const cleaned = result
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))
      .join('\n')

    if (cleaned && cleaned.split('\n').length < entries.length) {
      writeCategory(category, cleaned + '\n')
      console.log(`[extract] consolidated ${category}: ${entries.length} → ${cleaned.split('\n').length} entries`)
    }
  } catch (err) {
    console.error(`[extract] consolidate ${category} error:`, err)
    // 压缩失败不影响已有记忆，只是暂时多些重复条目
  }
}
