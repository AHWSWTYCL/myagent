import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, readFile, rm, access } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { FileOverlay } from '../speculative/fileOverlay.js'

let tmpBase: string
let overlay: FileOverlay

beforeEach(async () => {
  tmpBase = join(tmpdir(), `myagent-ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  await mkdir(tmpBase, { recursive: true })
  overlay = new FileOverlay(tmpBase)
  await overlay.init()
})

afterEach(async () => {
  await overlay.discard().catch(() => {})
  await rm(tmpBase, { recursive: true, force: true })
})

describe('FileOverlay — path key variants', () => {
  it('recognises file_path key', async () => {
    await writeFile(join(tmpBase, 'a.ts'), 'orig')
    const r = await overlay.rewritePath({ file_path: 'a.ts' }, true)
    expect((r as any).file_path).toContain(tmpdir())
    expect(overlay.writtenPaths.has('a.ts')).toBe(true)
  })

  it('recognises path key', async () => {
    await writeFile(join(tmpBase, 'b.ts'), 'orig')
    const r = await overlay.rewritePath({ path: 'b.ts' }, true)
    expect((r as any).path).toContain(tmpdir())
  })

  it('recognises target_file key', async () => {
    await writeFile(join(tmpBase, 'c.ts'), 'orig')
    const r = await overlay.rewritePath({ target_file: 'c.ts' }, true)
    expect((r as any).target_file).toContain(tmpdir())
  })

  it('returns input unchanged when no known path key', async () => {
    const input = { content: 'hello', size: 42 }
    const r = await overlay.rewritePath(input, true)
    expect(r).toEqual(input)
  })
})

describe('FileOverlay — absolute paths', () => {
  it('handles absolute path inside cwd', async () => {
    await writeFile(join(tmpBase, 'abs.ts'), 'orig')
    const absPath = join(tmpBase, 'abs.ts')
    const r = await overlay.rewritePath({ filePath: absPath }, true)
    expect((r as any).filePath).toContain(overlay.overlayPath)
    expect(overlay.writtenPaths.has('abs.ts')).toBe(true)
  })

  it('rejects absolute path outside cwd', async () => {
    const outside = '/etc/passwd'
    const r = await overlay.rewritePath({ filePath: outside }, true)
    expect((r as any).filePath).toBe(outside)
    expect(overlay.writtenPaths.size).toBe(0)
  })
})

describe('FileOverlay — multiple files', () => {
  it('tracks multiple written files independently', async () => {
    await writeFile(join(tmpBase, 'x.ts'), 'x')
    await writeFile(join(tmpBase, 'y.ts'), 'y')
    await overlay.rewritePath({ filePath: 'x.ts' }, true)
    await overlay.rewritePath({ filePath: 'y.ts' }, true)
    expect(overlay.writtenPaths.size).toBe(2)
    expect(overlay.writtenPaths.has('x.ts')).toBe(true)
    expect(overlay.writtenPaths.has('y.ts')).toBe(true)
  })

  it('second write to same file does not re-copy (CoW idempotent)', async () => {
    await writeFile(join(tmpBase, 'dup.ts'), 'orig')
    await overlay.rewritePath({ filePath: 'dup.ts' }, true)
    // overwrite overlay copy with something different
    await writeFile(join(overlay.overlayPath, 'dup.ts'), 'edited')
    // second rewritePath write should NOT re-copy (would overwrite 'edited' with 'orig')
    await overlay.rewritePath({ filePath: 'dup.ts' }, true)
    const content = await readFile(join(overlay.overlayPath, 'dup.ts'), 'utf-8')
    expect(content).toBe('edited')
  })

  it('accept copies all files back to cwd', async () => {
    await writeFile(join(tmpBase, 'p.ts'), 'orig-p')
    await writeFile(join(tmpBase, 'q.ts'), 'orig-q')
    await overlay.rewritePath({ filePath: 'p.ts' }, true)
    await overlay.rewritePath({ filePath: 'q.ts' }, true)
    await writeFile(join(overlay.overlayPath, 'p.ts'), 'new-p')
    await writeFile(join(overlay.overlayPath, 'q.ts'), 'new-q')
    await overlay.accept()
    expect(await readFile(join(tmpBase, 'p.ts'), 'utf-8')).toBe('new-p')
    expect(await readFile(join(tmpBase, 'q.ts'), 'utf-8')).toBe('new-q')
  })
})

describe('FileOverlay — subdirectory files', () => {
  it('handles nested paths', async () => {
    await mkdir(join(tmpBase, 'sub'), { recursive: true })
    await writeFile(join(tmpBase, 'sub', 'nested.ts'), 'orig')
    const r = await overlay.rewritePath({ filePath: 'sub/nested.ts' }, true)
    expect((r as any).filePath).toContain('sub')
    expect(overlay.writtenPaths.has('sub/nested.ts')).toBe(true)
  })

  it('accept restores nested file to cwd', async () => {
    await mkdir(join(tmpBase, 'sub'), { recursive: true })
    await writeFile(join(tmpBase, 'sub', 'deep.ts'), 'orig')
    await overlay.rewritePath({ filePath: 'sub/deep.ts' }, true)
    await mkdir(join(overlay.overlayPath, 'sub'), { recursive: true })
    await writeFile(join(overlay.overlayPath, 'sub', 'deep.ts'), 'updated')
    await overlay.accept()
    expect(await readFile(join(tmpBase, 'sub', 'deep.ts'), 'utf-8')).toBe('updated')
  })
})

describe('FileOverlay — discard', () => {
  it('removes overlay dir on discard', async () => {
    await overlay.rewritePath({ filePath: 'x.ts' }, true)
    const overlayDir = overlay.overlayPath
    await overlay.discard()
    await expect(access(overlayDir)).rejects.toThrow()
  })
})
