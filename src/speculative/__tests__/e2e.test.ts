/**
 * Speculative Execution Headless 端到端测试
 * 用法: npx tsx src/speculative/__tests__/e2e.test.ts
 *
 * 流程:
 * 1. 构造假的 sessionState（一条用户消息 + 一条 agent 回复）
 * 2. 用 ghostText 启动 speculation（真实 LLM API）
 * 3. 等待 speculation 完成
 * 4. accept() 并验证结果
 */
import { speculativeRunner } from '../speculativeRunner.js'
import { sessionState } from '../../state/sessionState.js'
import { ToolRegistrar } from '../../tools/toolregistrar.js'
import { loadClaudeSettings } from '../../config.js'
import type Anthropic from '@anthropic-ai/sdk'

async function main() {
  console.log('=== Speculative Execution E2E Test ===\n')

  // ── 1. 检查 LLM 配置 ──
  try {
    const cfg = loadClaudeSettings()
    if (!cfg.authToken && !cfg.apiKey) {
      console.log('SKIP: no auth token or API key in ~/.claude/settings-using-deepseek.json')
      process.exit(0)
    }
    console.log(`model: ${process.env.MYAGENT_MODEL || 'default'}`)
  } catch (err: any) {
    console.log(`SKIP: ${err.message}`)
    process.exit(0)
  }

  // ── 2. 准备 sessionState ──
  sessionState.replaceMessages([
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '2+2 equals 4.' },
  ])
  sessionState.setRunning(false)

  // 构建工具（只需要 read_file）
  const tools = new ToolRegistrar()
  try {
    const { ReadTool } = await import('../../tools/readtool.js')
    tools.registerTool(new (ReadTool as any)())
  } catch { /* 工具加载失败不影响核心流程 */ }
  const toolMap = tools.buildToolRenderMap()

  // 构建 system prompt
  const buildSystem = (): Anthropic.TextBlockParam[] => [
    { type: 'text', text: 'You are a helpful assistant. Keep responses short.' },
  ]

  const ghostText = 'What is 3+3?'

  console.log(`sessionState.messages: ${sessionState.messages.length} messages`)
  console.log(`ghostText: "${ghostText}"`)
  console.log(`agentRunning: ${sessionState.agentRunning}`)

  // ── 2. 启动 speculation ──
  console.log('\n--- Starting speculation ---')
  const startTime = Date.now()

  await speculativeRunner.startSpeculation(ghostText, {
    tools: toolMap,
    buildSystemSegments: buildSystem,
    canUseTool: (toolName, input, isWrite) =>
      speculativeRunner.defaultCanUseTool(toolName, input, isWrite),
  })

  const stateAfterStart = speculativeRunner.state
  console.log(`state after start: ${stateAfterStart.kind}`)
  if (stateAfterStart.kind !== 'running') {
    console.log('FAIL: speculation did not start (state is not running)')
    process.exit(1)
  }

  // ── 3. 等待完成 ──
  console.log('Waiting for speculation to complete...')
  const maxWait = 60_000 // 60s timeout
  const pollInterval = 500
  const deadline = Date.now() + maxWait

  while (Date.now() < deadline) {
    if (speculativeRunner.isDone) break
    await new Promise(r => setTimeout(r, pollInterval))
    process.stdout.write('.')
  }
  console.log()

  const elapsed = Date.now() - startTime

  if (!speculativeRunner.isDone) {
    console.log(`speculation still running after ${elapsed}ms, accepting anyway...`)
  }

  // ── 4. accept ──
  const result = await speculativeRunner.accept()
  if (!result) {
    console.log('FAIL: accept returned null')
    process.exit(1)
  }

  // ── 5. 验证 ──
  console.log('\n--- Results ---')
  console.log(`boundary.type: ${result.boundary?.type}`)
  console.log(`timeSavedMs: ${result.timeSavedMs}ms`)
  console.log(`includesUserMessage: ${result.includesUserMessage}`)
  console.log(`messages count: ${result.messages.length}`)

  const lastMsg = result.messages[result.messages.length - 1]
  console.log(`last message role: ${lastMsg?.role}`)
  if (typeof lastMsg?.content === 'string') {
    console.log(`last message preview: ${(lastMsg.content as string).slice(0, 100)}`)
  }

  // 验证消息完整性
  let ok = true

  // 原始 session + ghostText + agent 回复 = 3+ 条消息
  if (result.messages.length < 3) {
    console.log('FAIL: too few messages')
    ok = false
  }

  // complete 时 includesUserMessage 应为 true
  if (result.boundary?.type === 'complete' && !result.includesUserMessage) {
    console.log('FAIL: complete boundary but includesUserMessage is false')
    ok = false
  }

  // 时间应为正数
  if (result.timeSavedMs <= 0) {
    console.log('FAIL: timeSavedMs should be positive')
    ok = false
  }

  if (ok) {
    console.log('\n✅ E2E test PASSED')
  } else {
    console.log('\n❌ E2E test FAILED')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('E2E test error:', err)
  process.exit(1)
})
