/**
 * transcriptReader — 从 NDJSON transcript 文件加载事件并转换为 UI 可消费消息。
 *
 * 用途：
 *   - TeammateConversationView 从 transcriptPath 重建 teammate 对话历史
 *   - 将来可用于 session 回放、debug 等场景
 *
 * 使用方式：
 *   import { loadTranscriptEvents, transcriptToDisplayMessages } from './transcriptReader.js'
 *   const events = loadTranscriptEvents(task.transcriptPath)
 *   const messages = transcriptToDisplayMessages(events, teammateId)
 */

import fs from 'fs'

// ── Types ────────────────────────────────────────────────────────────

export interface TranscriptRecord {
  type: string
  ts: string
  agentId: string
  parentAgentId: string | null
  data: Record<string, unknown>
}

/** 与 TeammateConversationView 的 DisplayMessage 保持一致 */
export interface DisplayMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  from: string
  body: string
  timestamp: number
}

// ── Load ─────────────────────────────────────────────────────────────

/**
 * 加载一个 NDJSON transcript 文件，返回解析后的事件数组。
 * 文件不存在或读取失败时返回空数组（静默处理，因为 transcript 可能还在写入中）。
 */
export function loadTranscriptEvents(transcriptPath: string): TranscriptRecord[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return []

  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const records: TranscriptRecord[] = []
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as TranscriptRecord)
      } catch {
        // 损坏行跳过
      }
    }
    return records
  } catch {
    return []
  }
}

// ── Convert ──────────────────────────────────────────────────────────

/**
 * 将 transcript 事件转换为 DisplayMessage[] 供 TeammateConversationView 展示。
 *
 * 转换规则（demo 级）：
 *   - user_input → outgoing（用户/系统发给 teammate 的初始 prompt）
 *   - llm_response_end → incoming（teammate 的推理/回复文本）
 *   - tool_start → incoming 系统消息（🔧 toolName）
 *   - tool_end → incoming 系统消息（显示 outputSummary）
 *   - sub_agent_start / sub_agent_end → incoming 系统消息
 *
 * @param events 从 transcript NDJSON 加载的原始事件
 * @param teammateId teammate 的 agent_id，用于消息 from 字段
 */
export function transcriptToDisplayMessages(
  events: TranscriptRecord[],
  teammateId: string,
): DisplayMessage[] {
  const messages: DisplayMessage[] = []

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const timestamp = Date.parse(e.ts)

    switch (e.type) {
      case 'user_input': {
        const text = String(e.data.text ?? '')
        if (text) {
          messages.push({
            id: `tr-${i}`,
            direction: 'outgoing',
            from: 'main',
            body: text.length > 500 ? text.slice(0, 497) + '…' : text,
            timestamp,
          })
        }
        break
      }

      case 'llm_response_end': {
        const text = String(e.data.text ?? '')
        if (text) {
          messages.push({
            id: `tr-${i}`,
            direction: 'incoming',
            from: teammateId,
            body: text,
            timestamp,
          })
        }
        break
      }

      case 'tool_start': {
        const toolName = String(e.data.toolName ?? 'unknown')
        // 跳过不重要的内部工具显示（如 check_mail / send_mail —— 这些在 mailbox 视图里展示）
        // 但 transcript 视图不做过滤，全部展示更利于 debug
        messages.push({
          id: `tr-${i}`,
          direction: 'incoming',
          from: teammateId,
          body: `🔧 ${toolName}`,
          timestamp,
        })
        break
      }

      case 'tool_end': {
        const toolName = String(e.data.toolName ?? 'unknown')
        const outputSummary = String(e.data.outputSummary ?? '')
        const isError = e.data.isError === true
        const prefix = isError ? '✗' : '✓'
        const summary = outputSummary.length > 200
          ? outputSummary.slice(0, 197) + '…'
          : outputSummary
        messages.push({
          id: `tr-${i}`,
          direction: 'incoming',
          from: teammateId,
          body: `${prefix} ${toolName}${summary ? ': ' + summary : ''}`,
          timestamp,
        })
        break
      }

      case 'sub_agent_start': {
        const agentType = String(e.data.agentType ?? '')
        const desc = String(e.data.description ?? '')
        const body = agentType
          ? `Started sub-agent: ${agentType}${desc ? ' — ' + desc : ''}`
          : `Started`
        messages.push({
          id: `tr-${i}`,
          direction: 'incoming',
          from: teammateId,
          body,
          timestamp,
        })
        break
      }

      case 'sub_agent_end': {
        const agentType = String(e.data.agentType ?? '')
        const error = e.data.error ? String(e.data.error) : ''
        const toolUseCount = Number(e.data.toolUseCount ?? 0)
        const body = error
          ? `Sub-agent ${agentType} failed: ${error}`
          : `Sub-agent ${agentType} completed (${toolUseCount} tools)`
        messages.push({
          id: `tr-${i}`,
          direction: 'incoming',
          from: teammateId,
          body,
          timestamp,
        })
        break
      }
    }
  }

  // 按时间排序（虽然 NDJSON 通常已按写入顺序排列，但以防跨 timestamp 顺序问题）
  messages.sort((a, b) => a.timestamp - b.timestamp)

  return messages
}
