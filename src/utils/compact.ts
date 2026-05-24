import Anthropic from '@anthropic-ai/sdk'
import { withRetry } from '../client.js'

const COMPACT_SYSTEM = `你是一个对话历史压缩助手。你的任务是将一段对话历史压缩成一份简洁但完整的摘要，以便在新的上下文窗口中继续对话。

## 要求
- 保留所有重要的事实、决策、代码变更、文件路径、错误信息
- 保留用户的偏好和已确认的方向
- 保留未完成的任务和待解决的问题
- 去掉冗余的工具调用细节，只保留结果
- 用中文输出摘要
- 直接输出摘要内容，不要加任何前缀标题`

const KEEP_RECENT = 10       // 完整压缩后保留最近 N 条原始消息
const MC_KEEP_RECENT_TURNS = 5  // microcompact 保留最近 N 轮（每轮 = 一次 user+assistant 交换）

export const MICRO_COMPACT_TOKEN_THRESHOLD = 100_000
export const COMPACT_TOKEN_THRESHOLD = 150_000

// 这些工具的 result 内容体积大但事后价值低，microcompact 时直接清除
const CLEARABLE_TOOLS = new Set([
  'read_file', 'bash', 'list_dir', 'grep', 'glob', 'web_fetch', 'web_search',
])

const CLEARED_PLACEHOLDER = '[tool result cleared by microcompact]'

/**
 * Microcompact：纯本地操作，无需调用 LLM。
 * 把历史 tool_result（来自 CLEARABLE_TOOLS）的内容替换为占位符，只保留最近 MC_KEEP_RECENT 条消息不动。
 * 直接修改传入的 messages 数组，返回释放的估算 token 数。
 */
export function microcompactMessages(messages: Anthropic.MessageParam[]): number {
  // Find the cutoff index: keep the last MC_KEEP_RECENT_TURNS user-initiated turns.
  // A "turn" starts at a user message that is NOT a tool_result.
  const turnStarts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const isToolResult = Array.isArray(m.content) && m.content.length > 0 && m.content[0].type === 'tool_result'
    if (!isToolResult) turnStarts.push(i)
  }

  if (turnStarts.length <= MC_KEEP_RECENT_TURNS) return 0

  const cutoff = turnStarts[turnStarts.length - MC_KEEP_RECENT_TURNS]
  let freed = 0

  for (let i = 0; i < cutoff; i++) {
    const m = messages[i]
    if (m.role !== 'user' || typeof m.content === 'string') continue

    for (const block of m.content) {
      if (block.type !== 'tool_result') continue

      // Find the tool name from the paired tool_use block
      const toolUseId = block.tool_use_id
      const toolName = findToolName(messages, toolUseId)
      if (!toolName || !CLEARABLE_TOOLS.has(toolName)) continue

      const before = contentLength(block.content)
      if (before === 0) continue

      block.content = CLEARED_PLACEHOLDER
      freed += before
    }
  }

  return Math.ceil(freed / 4)
}

function findToolName(messages: Anthropic.MessageParam[], toolUseId: string): string | null {
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue
    for (const block of m.content) {
      if (block.type === 'tool_use' && block.id === toolUseId) return block.name
    }
  }
  return null
}

function contentLength(content: Anthropic.ToolResultBlockParam['content']): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce((sum, b) => sum + (b.type === 'text' ? b.text.length : 0), 0)
  }
  return 0
}

/** 粗略估算消息列表的 token 数（4 字符 ≈ 1 token） */
export function estimateTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else {
      for (const block of m.content) {
        if (block.type === 'text') chars += block.text.length
        else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length + block.name.length
        else if (block.type === 'tool_result') {
          const c = block.content
          if (typeof c === 'string') chars += c.length
          else if (Array.isArray(c)) chars += c.map(b => b.type === 'text' ? b.text.length : 0).reduce((a, b) => a + b, 0)
        }
      }
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * 将 messages 压缩：用 Claude 生成摘要，替换早期消息，保留最近 KEEP_RECENT 条原文。
 * 返回压缩后的新 messages 数组（原数组不变）。
 */
export async function compactMessages(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.MessageParam[]> {
  if (messages.length <= KEEP_RECENT + 2) return messages

  // Find a safe cut point: walk back KEEP_RECENT user-initiated turns from the end.
  // A user-initiated turn starts with a user message that is NOT a tool_result —
  // cutting here guarantees no orphaned tool_result at the head of toKeep.
  let keepFrom = messages.length
  let turnsFound = 0
  for (let i = messages.length - 1; i >= 0 && turnsFound < KEEP_RECENT; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const isToolResult = Array.isArray(m.content) && m.content.length > 0 && m.content[0].type === 'tool_result'
    if (!isToolResult) {
      keepFrom = i
      turnsFound++
    }
  }

  // Not enough clean turns to compact — nothing to do
  if (keepFrom === 0) return messages

  const toSummarize = messages.slice(0, keepFrom)
  const toKeep = messages.slice(keepFrom)

  const historyText = toSummarize
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant'
      if (typeof m.content === 'string') return `${role}: ${m.content}`
      const text = m.content
        .map(b => {
          if (b.type === 'text') return b.text
          if (b.type === 'tool_use') return `[调用工具 ${b.name}: ${JSON.stringify(b.input)}]`
          if (b.type === 'tool_result') {
            const c = b.content
            const result = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.type === 'text' ? x.text : '').join('') : ''
            return `[工具结果: ${result.slice(0, 500)}${result.length > 500 ? '...' : ''}]`
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return `${role}: ${text}`
    })
    .join('\n\n')

  const response = await withRetry(() => client.messages.create({
    model: 'claude-haiku-4-5',  // Summarization is cheap — Haiku is plenty.
    max_tokens: 4096,
    system: COMPACT_SYSTEM,
    messages: [{ role: 'user', content: `请压缩以下对话历史：\n\n${historyText}` }],
  }))

  const summaryBlock = response.content.find(b => b.type === 'text')
  const summary = summaryBlock ? summaryBlock.text.trim() : '（对话历史已压缩）'

  const continuationMessage = `This session is being continued from a previous conversation that has been compacted.

以下是之前对话的摘要：

${summary}`

  return [
    { role: 'user', content: continuationMessage },
    { role: 'assistant', content: '好的，我已了解之前的对话内容，继续为你服务。' },
    ...toKeep,
  ]
}
