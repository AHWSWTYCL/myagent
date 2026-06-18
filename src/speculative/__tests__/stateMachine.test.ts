/**
 * SpeculativeRunner 状态机转换测试（直接操作内部状态，无需 LLM）
 * 用法: npx tsx src/speculative/__tests__/stateMachine.test.ts
 */
import { speculativeRunner } from '../speculativeRunner.js'

let passed = 0
let failed = 0
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; return }
  failed++
  console.error(`  ❌ FAIL: ${msg}`)
}

// 通过反射访问私有状态
const runner = speculativeRunner as any

// ── 辅助函数：直接设置内部状态 ──
function resetToIdle() { runner.reset() }
function setRunning() {
  runner._state = { kind: 'running', abortController: new AbortController(), overlay: null, startTime: Date.now(), ghostTextIndex: 0, messagesRef: { current: [] }, boundary: null }
}
function setDone() { runner._state = { kind: 'done', result: { messages: [], boundary: { type: 'complete', completedAt: Date.now(), turnText: '' }, timeSavedMs: 100, includesUserMessage: true }, overlay: null } }
function setAborted() { runner._state = { kind: 'aborted', reason: 'test' } }

// ── Test: idle ──
console.log('=== State machine transitions ===')
resetToIdle()
assert(runner._state.kind === 'idle', 'initial state is idle')
assert(speculativeRunner.state.kind === 'idle', 'state getter: idle')
assert(!speculativeRunner.isRunning, 'isRunning: false')
assert(!speculativeRunner.isDone, 'isDone: false')

// ── Test: idle → running ──
setRunning()
assert(runner._state.kind === 'running', 'transition: idle → running')
assert(speculativeRunner.isRunning, 'isRunning: true')
assert(!speculativeRunner.isDone, 'isDone: false')

// ── Test: running → done ──
setDone()
assert(runner._state.kind === 'done', 'transition: running → done')
assert(!speculativeRunner.isRunning, 'isRunning: false after done')
assert(speculativeRunner.isDone, 'isDone: true')

// ── Test: done → idle (via accept) ──
setDone()
const result1 = await speculativeRunner.accept()
assert(result1 !== null, 'accept done state returns result')
assert(result1!.includesUserMessage === true, 'done result includesUserMessage: true')
assert(result1!.boundary?.type === 'complete', 'done boundary: complete')
assert(runner._state.kind === 'idle', 'done → idle after accept')

// ── Test: running → idle (via accept) ──
setRunning()
runner._state.messagesRef = { current: [
  { role: 'user', content: 'original' },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'ghostText' },
  { role: 'assistant', content: 'partial response' },
] }
runner._state.ghostTextIndex = 2
runner._runPromise = Promise.resolve()
const result2 = await speculativeRunner.accept()
assert(result2 !== null, 'accept running state returns result')
assert(result2!.includesUserMessage === false, 'incomplete result includesUserMessage: false')
assert(result2!.boundary?.type === 'incomplete', 'incomplete boundary: incomplete')
// 裁剪后：去掉 ghostText → [original_user, reply_asst, partial_asst]
// 末尾是 assistant，不 pop
assert(result2!.messages.length === 3, 'incomplete: 3 messages after ghostText strip')
assert(result2!.messages[0]!.role === 'user', 'msg[0] is original user')
assert(result2!.messages[2]!.role === 'assistant', 'msg[2] is partial assistant')
assert(runner._state.kind === 'idle', 'running → idle after accept')

// ── Test: idle accept returns null ──
resetToIdle()
const result3 = await speculativeRunner.accept()
assert(result3 === null, 'accept idle returns null')

// ── Test: aborted accept returns null ──
setAborted()
const result4 = await speculativeRunner.accept()
assert(result4 === null, 'accept aborted returns null')
assert(runner._state.kind === 'idle', 'aborted → idle after accept')

// ── Test: discard transitions ──
setRunning()
await speculativeRunner.discard()
assert(runner._state.kind === 'idle', 'running → idle after discard')

setDone()
await speculativeRunner.discard()
assert(runner._state.kind === 'idle', 'done → idle after discard')

// ── Test: discardSilent captures refs before reset ──
setRunning()
const ac = runner._state.abortController
runner.discardSilent()
assert(runner._state.kind === 'idle', 'discardSilent: state reset')
assert(ac.signal.aborted, 'discardSilent: abortController.abort() called')

// ── Test: ghostTextIndex 精确性 ──
setRunning()
runner._state.messagesRef = { current: [
  { role: 'user', content: 'u1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'ghost' },   // ghostTextIndex = 2
  { role: 'assistant', content: 's1' },
  { role: 'user', content: 'tool1' },   // tool_result, role=user
] }
runner._state.ghostTextIndex = 2
runner._runPromise = Promise.resolve()
const r = await speculativeRunner.accept()
assert(r !== null, 'accept with tool_result at end')
assert(r!.messages.length === 3, 'stripped ghost + popped trailing user')
assert(r!.messages[r!.messages.length - 1]!.role === 'assistant', 'ends with assistant')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
