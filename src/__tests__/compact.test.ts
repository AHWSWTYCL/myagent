import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { microcompactMessages, MICRO_COMPACT_TOKEN_THRESHOLD } from '../utils/compact.js'

function userText(text: string): Anthropic.MessageParam {
  return { role: 'user', content: text }
}

function assistantToolCall(id: string, name: string): Anthropic.MessageParam {
  return { role: 'assistant', content: [
    { type: 'tool_use', id, name, input: {} },
  ] }
}

function userToolResult(id: string, content: string): Anthropic.MessageParam {
  return { role: 'user', content: [
    { type: 'tool_result', tool_use_id: id, content },
  ] }
}

describe('microcompact', () => {
  it('clears older read_file results past the keep window', () => {
    const messages: Anthropic.MessageParam[] = []
    for (let i = 0; i < 8; i++) {
      messages.push(userText(`turn ${i}`))
      messages.push(assistantToolCall(`r${i}`, 'read_file'))
      messages.push(userToolResult(`r${i}`, 'A'.repeat(2000)))
    }

    const freed = microcompactMessages(messages)
    expect(freed).toBeGreaterThan(0)
  })

  it('does clear bash results in older turns', () => {
    const messages: Anthropic.MessageParam[] = []
    for (let i = 0; i < 8; i++) {
      messages.push(userText(`turn ${i}`))
      messages.push(assistantToolCall(`b${i}`, 'bash'))
      messages.push(userToolResult(`b${i}`, 'X'.repeat(2000)))
    }

    const freed = microcompactMessages(messages)
    expect(freed).toBeGreaterThan(0)

    // The OLDEST turns should be cleared; the most recent N turns should not.
    const cleared = messages
      .flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(b => b.type === 'tool_result' && typeof b.content === 'string' && b.content.startsWith('[tool result cleared'))
    expect(cleared.length).toBeGreaterThan(0)
  })

  it('does nothing when message list is short', () => {
    const messages: Anthropic.MessageParam[] = [
      userText('hi'),
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]
    expect(microcompactMessages(messages)).toBe(0)
  })
})

describe('compact thresholds', () => {
  it('exposes threshold constants', () => {
    expect(MICRO_COMPACT_TOKEN_THRESHOLD).toBeGreaterThan(0)
  })
})
