/**
 * Headless test for the workflow module.
 * Run: npx tsx scripts/test-workflow.ts
 */

import { createClient } from '../src/client.js'
import { ToolRegistrar } from '../src/tools/toolregistrar.js'
import { runWorkflow } from '../src/workflow/runtime.js'
import type { AgentRunContext } from '../src/agents/definition.js'

// ── Minimal AgentRunContext ──────────────────────────────────────────────────
const client = createClient()
const toolRegistrar = new ToolRegistrar()

const ctx: AgentRunContext = {
  source: 'workflow-test',
  client,
  toolRegistrar,
  executeTool: async (name, _input) => `(tool ${name} not available in test)`,
  emitLine: (line: string) => console.error('[workflow]', line),
  onSubAgentDelta: (_name, delta) => process.stderr.write(delta),
  onSubAgentProgress: (name, toolCount, tokens) => {
    if (tokens > 0) console.error(`[progress] ${name} tools=${toolCount} tokens=${tokens}`)
  },
}

// ── Test 1: 单个 agent() 调用 ────────────────────────────────────────────────
console.error('\n=== Test 1: single agent() call ===')
const result1 = await runWorkflow({
  ctx,
  script: `
    phase('Greet')
    log('calling agent...')
    const reply = await agent('Reply with exactly: WORKFLOW_OK')
    log('got: ' + String(reply).slice(0, 80))
    return reply
  `,
})
console.log('\n[Test 1 result]')
console.log('runId:', result1.runId)
console.log('returnValue:', String(result1.returnValue).slice(0, 200))
console.log('outputTokens:', result1.outputTokens)

// ── Test 2: pipeline() 并行处理 ──────────────────────────────────────────────
console.error('\n=== Test 2: pipeline() with 3 items ===')
const result2 = await runWorkflow({
  ctx,
  script: `
    phase('Pipeline')
    const items = ['apple', 'banana', 'cherry']
    const results = await pipeline(
      items,
      item => agent('One word description of: ' + item, { label: 'describe:' + item }),
      (desc, item) => item + ' → ' + String(desc).trim()
    )
    return results
  `,
})
console.log('\n[Test 2 result]')
console.log('items:', result2.returnValue)

// ── Test 3: schema 结构化输出 ────────────────────────────────────────────────
console.error('\n=== Test 3: schema structured output ===')
const SCHEMA = {
  type: 'object',
  properties: {
    word: { type: 'string' },
    length: { type: 'number' },
  },
  required: ['word', 'length'],
}
const result3 = await runWorkflow({
  ctx,
  script: `
    const schema = ${JSON.stringify(SCHEMA)}
    const data = await agent(
      'Return JSON: word="hello" length=5',
      { schema, label: 'schema-test' }
    )
    return data
  `,
})
console.log('\n[Test 3 result]')
console.log('structured:', JSON.stringify(result3.returnValue, null, 2))

// ── Test 4: Journal 恢复（resume） ────────────────────────────────────────────
console.error('\n=== Test 4: journal resume ===')
const run4a = await runWorkflow({
  ctx,
  script: `
    const r = await agent('Say: CACHED_RESULT', { label: 'resumable' })
    return r
  `,
})
console.error('[resume] first run id:', run4a.runId)

const run4b = await runWorkflow({
  ctx,
  resumeFromRunId: run4a.runId,
  script: `
    const r = await agent('Say: CACHED_RESULT', { label: 'resumable' })
    return r
  `,
})
console.log('\n[Test 4 result]')
console.log('first:', String(run4a.returnValue).slice(0, 80))
console.log('resumed (should match):', String(run4b.returnValue).slice(0, 80))
console.log('cache hit:', run4a.returnValue === run4b.returnValue ? 'YES ✓' : 'NO (different objects, check content)')

console.error('\n=== All tests complete ===')
