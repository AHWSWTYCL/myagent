import Anthropic from '@anthropic-ai/sdk'

export function extractLastText(messages: Anthropic.MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = msg.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
      if (text) return text
    }
  }
  return ''
}

export function makePrefixedOnText(prefix: string): (delta: string) => void {
  let needsPrefix = true
  return (delta: string) => {
    let out = ''
    for (const ch of delta) {
      if (needsPrefix) { out += prefix + ' '; needsPrefix = false }
      out += ch
      if (ch === '\n') needsPrefix = true
    }
    process.stdout.write(out)
  }
}

/**
 * Like makePrefixedOnText but routes deltas through an emitLine callback
 * instead of writing directly to stdout. Use this inside sub-agent tools so
 * their output surfaces in the TUI rather than bypassing Ink's renderer.
 */
export function makePrefixedEmit(
  prefix: string,
  emitLine: (line: string) => void,
): (delta: string) => void {
  let buf = ''
  return (delta: string) => {
    buf += delta
    const lines = buf.split('\n')
    // All but the last element are complete lines
    for (let i = 0; i < lines.length - 1; i++) {
      emitLine(`${prefix} ${lines[i]}`)
    }
    buf = lines[lines.length - 1]
  }
}
