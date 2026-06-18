/**
 * FileOverlay 独立测试
 * 用法: npx tsx src/speculative/__tests__/fileOverlay.test.ts
 */
import { mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { FileOverlay } from '../fileOverlay.js'

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; return }
  failed++
  console.error(`  ❌ FAIL: ${msg}`)
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual === expected) { passed++; return }
  failed++
  console.error(`  ❌ FAIL: ${msg}`)
  console.error(`     expected: ${JSON.stringify(expected)}`)
  console.error(`     actual:   ${JSON.stringify(actual)}`)
}

async function main() {
  const tmpBase = join(tmpdir(), `myagent-test-${Date.now().toString(36)}`)
  await mkdir(tmpBase, { recursive: true })

  const testFile = join(tmpBase, 'hello.txt')
  await writeFile(testFile, 'original content')

  const overlay = new FileOverlay(tmpBase)

  // ── Test 1: init ──
  console.log('Test 1: init()')
  const ok = await overlay.init()
  assert(ok, 'init returns true')

  // ── Test 2: write — copy-on-write ──
  console.log('Test 2: rewritePath write (copy-on-write)')
  const rewritten = await overlay.rewritePath({ filePath: 'hello.txt', content: 'x' }, true)
  assert((rewritten as any).filePath !== 'hello.txt', 'filePath was rewritten')
  assert((rewritten as any).filePath.startsWith(tmpdir()), 'rewritten path is in tmpdir')
  assert(overlay.writtenPaths.has('hello.txt'), 'writtenPaths tracks the file')
  const overlayContent = await readFile((rewritten as any).filePath, 'utf-8')
  assertEq(overlayContent, 'original content', 'CoW copied original content')

  // ── Test 3: read redirect to overlay ──
  console.log('Test 3: rewritePath read (redirect to overlay)')
  const readRewritten = await overlay.rewritePath({ filePath: 'hello.txt' }, false)
  assert((readRewritten as any).filePath.startsWith(tmpdir()), 'read redirects to overlay for written files')

  // ── Test 4: read no redirect for unwritten ──
  console.log('Test 4: rewritePath read (no redirect)')
  const r2 = await overlay.rewritePath({ filePath: 'nonexistent.txt' }, false)
  assertEq((r2 as any).filePath, 'nonexistent.txt', 'unwritten files not redirected')

  // ── Test 5: path traversal rejected ──
  console.log('Test 5: path traversal rejection')
  const trav = await overlay.rewritePath({ filePath: '../outside.txt' }, true)
  assertEq((trav as any).filePath, '../outside.txt', 'path traversal not rewritten')
  assert(!overlay.writtenPaths.has('../outside.txt'), 'not added to writtenPaths')

  // ── Test 6: unknown path key ──
  console.log('Test 6: unknown path key')
  const u = await overlay.rewritePath({ foo: 'bar' }, true)
  assertEq((u as any).foo, 'bar', 'no path key — returned unchanged')

  // ── Test 7: accept ──
  console.log('Test 7: accept() — copy overlay back to cwd')
  await writeFile(join(overlay.overlayPath, 'hello.txt'), 'speculative edit')
  await overlay.accept()
  assertEq(await readFile(testFile, 'utf-8'), 'speculative edit', 'accept copied overlay → cwd')

  // ── Test 8: discard ──
  console.log('Test 8: discard() — clean up overlay')
  const overlay2 = new FileOverlay(tmpBase)
  await overlay2.init()
  await overlay2.rewritePath({ filePath: 'hello.txt' }, true)
  await overlay2.discard()
  try {
    await readFile(join(overlay2.overlayPath, 'hello.txt'))
    assert(false, 'overlay dir should be deleted after discard')
  } catch { passed++ }

  // ── Test 9: new file (original doesn't exist) ──
  console.log('Test 9: copy-on-write for new file')
  const overlay3 = new FileOverlay(tmpBase)
  await overlay3.init()
  await overlay3.rewritePath({ filePath: 'new-file.ts' }, true)
  assert(overlay3.writtenPaths.has('new-file.ts'), 'new file tracked')
  await overlay3.discard()

  // ── Cleanup ──
  await rm(tmpBase, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Test harness error:', err)
  process.exit(1)
})
