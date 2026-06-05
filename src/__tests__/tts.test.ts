import { describe, it, expect } from 'vitest'
import { sanitizeForSpeech } from '../voice/tts.js'

describe('sanitizeForSpeech', () => {
  it('drops fenced code blocks and replaces with a marker', () => {
    const input = '看下面：\n```ts\nconst x = 1\n```\n就这样。'
    const out = sanitizeForSpeech(input)
    expect(out).not.toContain('const x')
    expect(out).toContain('代码块')
    expect(out).toContain('就这样')
  })

  it('strips inline backticks but keeps the word inside', () => {
    expect(sanitizeForSpeech('use `foo()` to call')).toBe('use foo() to call')
  })

  it('replaces bare URLs with the word "链接"', () => {
    const out = sanitizeForSpeech('see https://example.com/path for more')
    expect(out).not.toContain('https')
    expect(out).toContain('链接')
  })

  it('keeps link text and drops the URL portion', () => {
    expect(sanitizeForSpeech('点击 [文档](https://x.com) 查看')).toBe('点击 文档 查看')
  })

  it('removes markdown heading and list markers', () => {
    const input = '# 标题\n- 第一项\n- 第二项\n## 小标题'
    const out = sanitizeForSpeech(input)
    expect(out).not.toContain('#')
    expect(out).not.toMatch(/^\s*-/)
    expect(out).toContain('标题')
    expect(out).toContain('第一项')
  })

  it('strips bold and italic markers', () => {
    expect(sanitizeForSpeech('这是 **加粗** 和 *斜体*')).toBe('这是 加粗 和 斜体')
  })

  it('removes decorative symbols and emojis', () => {
    const out = sanitizeForSpeech('✓ 完成 ⚠ 警告 🚀 上线')
    expect(out).toContain('完成')
    expect(out).toContain('警告')
    expect(out).toContain('上线')
    expect(out).not.toContain('✓')
    expect(out).not.toContain('⚠')
    expect(out).not.toContain('🚀')
  })

  it('returns empty for input that becomes too short after cleaning', () => {
    expect(sanitizeForSpeech('  ')).toBe('')
    expect(sanitizeForSpeech('#')).toBe('')
    expect(sanitizeForSpeech('•')).toBe('')
  })

  it('collapses repeated whitespace', () => {
    expect(sanitizeForSpeech('a    b\n\n\nc')).toBe('a b c')
  })

  it('drops images entirely', () => {
    expect(sanitizeForSpeech('前 ![alt](pic.png) 后')).toBe('前 后')
  })

  it('an empty fenced block still announces "代码块"', () => {
    expect(sanitizeForSpeech('```\n```')).toContain('代码块')
  })
})
