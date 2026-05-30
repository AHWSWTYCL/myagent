import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { EditTool } from '../tools/edittool.js'
import { fileStateCache } from '../utils/fileStateCache.js'
import { ReadTool } from '../tools/readtool.js'

const TEST_DIR = '/tmp/myagent-edit-test'

function testFile(name: string): string {
  return path.join(TEST_DIR, name)
}

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true })
  fileStateCache.clear()
})

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
  fileStateCache.clear()
})

describe('EditTool', () => {
  const tool = new EditTool()
  const reader = new ReadTool()

  it('refuses edit if file was not read first', async () => {
    const result = await tool.execute({
      file_path: testFile('unread.txt'),
      old_string: 'hello',
      new_string: 'world',
    })
    expect(result).toContain('has not been read yet')
  })

  it('edits a file with exact match', async () => {
    const fp = testFile('simple.txt')
    fs.writeFileSync(fp, 'Hello World\nFoo Bar\nHello World', 'utf-8')
    await reader.execute({ path: fp })

    const result = await tool.execute({
      file_path: fp,
      old_string: 'Foo Bar',
      new_string: 'Baz Qux',
    })

    const parsed = JSON.parse(result)
    expect(parsed.diff.additions).toBe(1)
    expect(parsed.diff.removals).toBe(1)
    expect(fs.readFileSync(fp, 'utf-8')).toContain('Baz Qux')
  })

  it('rejects ambiguous match without replace_all', async () => {
    const fp = testFile('ambiguous.txt')
    fs.writeFileSync(fp, 'Hello World\nHello World\nHello World', 'utf-8')
    await reader.execute({ path: fp })

    const result = await tool.execute({
      file_path: fp,
      old_string: 'Hello World',
      new_string: 'Hi There',
    })
    expect(result).toContain('3 matches')
    expect(result).toContain('replace_all')
  })

  it('replaces all with replace_all=true', async () => {
    const fp = testFile('replace-all.txt')
    fs.writeFileSync(fp, 'Hello World\nFoo\nHello World\nBar\nHello World', 'utf-8')
    await reader.execute({ path: fp })

    const result = await tool.execute({
      file_path: fp,
      old_string: 'Hello World',
      new_string: 'Hi There',
      replace_all: true,
    })

    const parsed = JSON.parse(result)
    expect(parsed.diff.additions).toBe(3)
    expect(parsed.diff.removals).toBe(3)
    const content = fs.readFileSync(fp, 'utf-8')
    expect(content).not.toContain('Hello World')
    expect(content.match(/Hi There/g)!.length).toBe(3)
  })

  it('rejects edit after file was externally modified', async () => {
    const fp = testFile('stale.txt')
    fs.writeFileSync(fp, 'Original Content', 'utf-8')
    await reader.execute({ path: fp })

    // 外部修改文件
    fs.writeFileSync(fp, 'Modified Externally', 'utf-8')

    const result = await tool.execute({
      file_path: fp,
      old_string: 'Original',
      new_string: 'Changed',
    })
    expect(result).toContain('has been modified since read')
  })

  it('handles quote normalization', async () => {
    const fp = testFile('quotes.txt')
    // 文件中使用花引号
    fs.writeFileSync(fp, 'She said \u201CHello\u201D to me', 'utf-8')
    await reader.execute({ path: fp })

    // LLM 输出直引号版本
    const result = await tool.execute({
      file_path: fp,
      old_string: 'She said "Hello" to me',
      new_string: 'She said "Goodbye" to me',
    })

    expect(result).not.toContain('Error')
    const parsed = JSON.parse(result)
    expect(parsed.diff.additions).toBe(1)

    // 文件中应保持花引号风格
    const content = fs.readFileSync(fp, 'utf-8')
    expect(content).toContain('\u201C')
    expect(content).toContain('\u201D')
    expect(content).not.toContain('"Goodbye"')
  })

  it('rejects write-only file paths too', async () => {
    const fp = testFile('write-only.txt')
    // 写文件但不读
    fs.writeFileSync(fp, 'hello', 'utf-8')

    const result = await tool.execute({
      file_path: fp,
      old_string: 'hello',
      new_string: 'world',
    })
    expect(result).toContain('has not been read yet')
  })

  it('works with both file_path and path params', async () => {
    const fp = testFile('param-compat.txt')
    fs.writeFileSync(fp, 'Testing compatibility', 'utf-8')
    await reader.execute({ path: fp })

    const result = await tool.execute({
      path: fp,
      old_string: 'compatibility',
      new_string: 'backward compat',
    })
    expect(result).not.toContain('Error')
    const parsed = JSON.parse(result)
    expect(parsed.diff.additions).toBe(1)
  })
})
