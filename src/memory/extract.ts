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

// DeepSeek V4 Flash：便宜、快，适合记忆提取/合并这类轻量任务。
// createClient() 实际走 settings-using-deepseek.json → DeepSeek 兼容 API。
const EXTRACT_MODEL = 'deepseek-v4-flash'

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

/** 把抽取出的记忆追加到对应分类，去重（精确匹配 + 模糊匹配）。返回新增条数。
 *  Per-category mutex serializes append + consolidate so concurrent extracts
 *  (fire-and-forget from runTurn / hooks) can't lost-update each other. */
const categoryLocks: Map<MemoryCategory, Promise<unknown>> = new Map()

function withLock<T>(category: MemoryCategory, fn: () => Promise<T>): Promise<T> {
  const previous = categoryLocks.get(category) ?? Promise.resolve()
  const next = previous.then(fn, fn)  // run regardless of prior outcome
  // Track the latest promise; clear if it's still the tail when it settles
  // so the map doesn't accumulate stale entries.
  categoryLocks.set(category, next)
  next.finally(() => {
    if (categoryLocks.get(category) === next) categoryLocks.delete(category)
  })
  return next
}

export async function appendMemories(items: ExtractedMemory[]): Promise<number> {
  let added = 0
  // Group by category so each lock is held once per call (not per item).
  const grouped = new Map<MemoryCategory, ExtractedMemory[]>()
  for (const item of items) {
    const list = grouped.get(item.category) ?? []
    list.push(item)
    grouped.set(item.category, list)
  }

  for (const [category, group] of grouped) {
    added += await withLock(category, async () => {
      let localAdded = 0
      const existing = readCategory(category)
      const lines = existing
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '))

      for (const item of group) {
        const newEntry = `- ${item.content}`

        // 第一道防御：精确匹配
        if (lines.includes(newEntry)) continue

        // 第二道防御：模糊匹配（归一化后相同或包含）
        const isDuplicate = lines.some(existingLine => isSimilar(existingLine, newEntry))
        if (isDuplicate) continue

        lines.push(newEntry)
        localAdded++
      }

      if (localAdded > 0) {
        writeCategory(category, lines.join('\n') + '\n')
      }

      // 定期压缩：当条目超过上限时，异步触发 LLM 合并
      if (lines.length > MAX_ENTRIES_PER_CATEGORY) {
        consolidateCategory(category).catch(err =>
          console.error(`[extract] consolidate ${category} failed:`, err),
        )
      }
      return localAdded
    })
  }
  return added
}

/** 对某个分类做 LLM 批量合并：将语义相似的记忆合并为一条，保留最完整表述。 */
async function consolidateCategory(category: MemoryCategory): Promise<void> {
  // The LLM call itself is unlocked (long-running). Re-read & re-write under
  // the lock so a concurrent appendMemories doesn't get clobbered.
  const raw = readCategory(category)
  const entries = raw.split('\n').filter(l => l.trim().startsWith('- '))
  if (entries.length <= MAX_ENTRIES_PER_CATEGORY) return

  const client = createClient()
  let cleaned: string | null = null
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

    cleaned = result
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))
      .join('\n')
  } catch (err) {
    console.error(`[extract] consolidate ${category} error:`, err)
    return
  }

  if (!cleaned) return

  // Lock + re-read: file may have grown while the LLM call was in flight.
  // Merge: drop entries the LLM dropped, but preserve any new entries appended
  // during the wait by reapplying them on top.
  await withLock(category, async () => {
    const beforeLines = entries
    const afterLines = cleaned!.split('\n').filter(l => l.trim().startsWith('- '))
    if (afterLines.length >= beforeLines.length) return  // nothing actually merged

    const currentRaw = readCategory(category)
    const currentLines = currentRaw.split('\n').filter(l => l.trim().startsWith('- '))
    // Entries appended after consolidation started: anything in current that
    // wasn't in `beforeLines`.
    const beforeSet = new Set(beforeLines)
    const newSinceStart = currentLines.filter(l => !beforeSet.has(l))

    const finalLines = [...afterLines, ...newSinceStart]
    if (finalLines.length < currentLines.length) {
      writeCategory(category, finalLines.join('\n') + '\n')
      console.log(`[extract] consolidated ${category}: ${currentLines.length} → ${finalLines.length} entries`)
    }
  })
}
