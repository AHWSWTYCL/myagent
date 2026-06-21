import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolvePathPrefix, getFileSuggestions } from '../tui/fileSuggestions.js'

let tmpBase: string

beforeAll(async () => {
  tmpBase = join(tmpdir(), `myagent-fstest-${Date.now().toString(36)}`)
  await mkdir(join(tmpBase, 'src', 'tui'), { recursive: true })
  await mkdir(join(tmpBase, 'src', 'tools'), { recursive: true })
  await mkdir(join(tmpBase, '.hidden'), { recursive: true })
  await writeFile(join(tmpBase, 'src', 'tui', 'App.tsx'), '')
  await writeFile(join(tmpBase, 'src', 'tui', 'types.ts'), '')
  await writeFile(join(tmpBase, 'src', 'tools', 'readtool.ts'), '')
  await writeFile(join(tmpBase, 'README.md'), '')
  await writeFile(join(tmpBase, '.env'), '')
})

afterAll(async () => {
  await rm(tmpBase, { recursive: true, force: true })
})

describe('resolvePathPrefix', () => {
  it('empty prefix → cwd with empty filePrefix', async () => {
    const r = await resolvePathPrefix('', tmpBase)
    expect(r).not.toBeNull()
    expect(r!.searchDir).toBe(tmpBase)
    expect(r!.filePrefix).toBe('')
  })

  it('partial filename → correct searchDir + filePrefix', async () => {
    const r = await resolvePathPrefix('src/tui/A', tmpBase)
    expect(r).not.toBeNull()
    expect(r!.filePrefix).toBe('A')
    expect(r!.searchDir).toContain('tui')
  })

  it('directory path with trailing slash → list dir', async () => {
    const r = await resolvePathPrefix('src/tui/', tmpBase)
    expect(r).not.toBeNull()
    expect(r!.filePrefix).toBe('')
  })

  it('nonexistent parent → null', async () => {
    const r = await resolvePathPrefix('does/not/exist/file.ts', tmpBase)
    expect(r).toBeNull()
  })

  it('absolute path to existing dir', async () => {
    const r = await resolvePathPrefix(join(tmpBase, 'src', 'tui'), tmpBase)
    expect(r).not.toBeNull()
    expect(r!.filePrefix).toBe('')
  })

  it('tilde expansion', async () => {
    const r = await resolvePathPrefix('~/', tmpBase)
    // ~/  always exists on this machine
    expect(r).not.toBeNull()
  })
})

describe('getFileSuggestions', () => {
  it('empty prefix lists files + dirs at cwd, dirs first', async () => {
    const results = await getFileSuggestions('', tmpBase)
    const dirs = results.filter(r => r.kind === 'directory')
    const files = results.filter(r => r.kind === 'file')
    expect(dirs.length).toBeGreaterThan(0)
    // dirs come before files
    const lastDirIdx = results.findLastIndex(r => r.kind === 'directory')
    const firstFileIdx = results.findIndex(r => r.kind === 'file')
    expect(lastDirIdx).toBeLessThan(firstFileIdx)
  })

  it('partial dir prefix filters correctly', async () => {
    const results = await getFileSuggestions('sr', tmpBase)
    expect(results.every(r => r.name.toLowerCase().startsWith('sr'))).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })

  it('hidden files excluded unless prefix starts with dot', async () => {
    const visible = await getFileSuggestions('', tmpBase)
    expect(visible.find(r => r.name === '.env')).toBeUndefined()
    expect(visible.find(r => r.name === '.hidden')).toBeUndefined()

    // Need an explicit dot prefix (e.g. ".e") — bare "." is treated as cwd with empty filePrefix
    const hidden = await getFileSuggestions('.e', tmpBase)
    expect(hidden.find(r => r.name === '.env')).toBeDefined()
  })

  it('atPath is @-prefixed and matches name', async () => {
    const results = await getFileSuggestions('src/tui/', tmpBase)
    for (const r of results) {
      expect(r.atPath).toMatch(/^@/)
      expect(r.atPath).toContain(r.name)
    }
  })

  it('directory suggestion kind is directory', async () => {
    // 'src' resolves to the dir itself (lists its contents), use 'sr' to match 'src' as an entry
    const results = await getFileSuggestions('sr', tmpBase)
    const srcDir = results.find(r => r.name === 'src')
    expect(srcDir?.kind).toBe('directory')
  })

  it('no results for nonexistent prefix', async () => {
    const results = await getFileSuggestions('zzz', tmpBase)
    expect(results).toHaveLength(0)
  })

  it('node_modules excluded', async () => {
    await mkdir(join(tmpBase, 'node_modules'), { recursive: true })
    const results = await getFileSuggestions('', tmpBase)
    expect(results.find(r => r.name === 'node_modules')).toBeUndefined()
  })
})
