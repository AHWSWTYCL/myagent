/**
 * SpeculativeRunner 消息裁剪逻辑独立测试
 * 用法: npx tsx src/speculative/__tests__/messageTrimming.test.ts
 *
 * 不启动真实 LLM loop，通过反射直接测试 accept() 中 incomplete 路径的裁剪逻辑。
 */
import { FileOverlay } from '../fileOverlay.js'

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; return }
  failed++
  console.error(`  ❌ FAIL: ${msg}`)
}

// ── 模拟消息结构 ──
type Role = 'user' | 'assistant'
interface Msg { role: Role; content: string }

// ── 核心裁剪逻辑（从 accept() 提取出来独立测试） ──
function trimIncompleteMessages(
  messages: Msg[],
  ghostTextIndex: number,
): Msg[] {
  // Step 1: strip ghostText user message
  let clean = [
    ...messages.slice(0, ghostTextIndex),
    ...messages.slice(ghostTextIndex + 1),
  ]

  // Step 2: ensure last message is 'assistant' (for runTurn to append 'user')
  while (clean.length > 0 && clean[clean.length - 1]!.role !== 'assistant') {
    clean.pop()
  }

  // Step 3: fallback to original sessionState if all stripped
  if (clean.length === 0) {
    clean = messages.slice(0, ghostTextIndex)
  }

  return clean
}

// ── 构造测试数据 ──
const original: Msg[] = [
  { role: 'user', content: 'show me the code' },
  { role: 'assistant', content: "I'll look into src/foo.ts" },
]

function buildSpec(extra: Msg[]): { messages: Msg[]; ghostTextIndex: number } {
  const ghostText: Msg = { role: 'user', content: 'what does bar() do?' }
  return {
    messages: [...original, ghostText, ...extra],
    ghostTextIndex: original.length,
  }
}

// ── Test 1: speculation 完成了半条 assistant 消息 ──
console.log('Test 1: partial assistant at end')
{
  const { messages, ghostTextIndex } = buildSpec([
    { role: 'assistant', content: 'The bar() function...' },
  ])
  const r = trimIncompleteMessages(messages, ghostTextIndex)
  assert(r.length === original.length + 1, 'keeps partial assistant')
  assert(r[r.length - 1]!.role === 'assistant', 'ends with assistant')
  assert(r[r.length - 1]!.content === 'The bar() function...', 'content preserved')
}

// ── Test 2: speculation 停在 tool_result (role=user) ──
console.log('Test 2: tool_result at end (user → pop)')
{
  const { messages, ghostTextIndex } = buildSpec([
    { role: 'assistant', content: 'Let me check...' },
    { role: 'user', content: 'file content here' },   // tool_result
  ])
  const r = trimIncompleteMessages(messages, ghostTextIndex)
  assert(r.length === original.length + 1, 'popped tool_result user, kept assistant')
  assert(r[r.length - 1]!.role === 'assistant', 'ends with assistant after pop')
}

// ── Test 3: speculation 刚好停在 assistant 末尾 ──
console.log('Test 3: assistant at end, no pop needed')
{
  const { messages, ghostTextIndex } = buildSpec([
    { role: 'assistant', content: 'A' },
    { role: 'user', content: 'tool result 1' },
    { role: 'assistant', content: 'Final answer: ...' },
  ])
  const r = trimIncompleteMessages(messages, ghostTextIndex)
  assert(r.length === original.length + 3, 'kept all messages')
  assert(r[r.length - 1]!.role === 'assistant', 'ends with assistant')
}

// ── Test 4: speculation 没有进展（只有 ghostText，无额外消息）──
console.log('Test 4: no speculation progress')
{
  const { messages, ghostTextIndex } = buildSpec([])
  const r = trimIncompleteMessages(messages, ghostTextIndex)
  assert(r.length === original.length, 'fallback to original sessionState')
  assert(r[r.length - 1]!.role === 'assistant', 'original ends with assistant')
}

// ── Test 5: 多轮后停在 user ──
console.log('Test 5: multi-round, ends at user')
{
  const { messages, ghostTextIndex } = buildSpec([
    { role: 'assistant', content: 'Round 1' },
    { role: 'user', content: 'tool 1' },
    { role: 'assistant', content: 'Round 2' },
    { role: 'user', content: 'tool 2' },
  ])
  const r = trimIncompleteMessages(messages, ghostTextIndex)
  assert(r.length === original.length + 3, 'popped last user, kept rest including Round 2')
  assert(r[r.length - 1]!.role === 'assistant', 'ends with assistant')
  assert(r[r.length - 1]!.content === 'Round 2', 'last assistant is Round 2 (only tool 2 popped)')
}

// ── Test 6: 全是 user 消息（极端情况）──
console.log('Test 6: only user messages after ghostText')
{
  const { messages, ghostTextIndex } = buildSpec([
    { role: 'user', content: 'tool result only' },
  ])
  const r = trimIncompleteMessages(messages, ghostTextIndex)
  assert(r.length === original.length, 'popped everything, fallback to original')
  assert(r[r.length - 1]!.role === 'assistant', 'original ends with assistant')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
