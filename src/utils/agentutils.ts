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
