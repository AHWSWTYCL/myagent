// ── myagent entry point ────────────────────────────────────────────────────────
// 职责：CLI dispatch（TUI vs debug），不包含初始化逻辑和运行时逻辑。
// 初始化/装配 → bootstrap.ts
// 运行时函数   → turn.ts

import {
  bridge,
  originalConsoleLog,
  originalConsoleError,
  toolRegistrar,
  sessionState,
  transcriptRecorder,
  mcpManager,
  bgManager,
  commandParser,
  initialTuiMessages,
  enqueueUserMessage,
  enqueueMainMailboxWake,
  subscribeQueue,
  getQueueLength,
  drainQueue,
} from './bootstrap.js'
import { runTurn, runBash } from './turn.js'
import { Scheduler } from './scheduler/scheduler.js'
import { Mailbox } from './mailbox/mailbox.js'
import { AppStateProvider, appStateStore } from './state/AppStateProvider.js'
import { App } from './tui/App.js'
import React from 'react'
import { render } from 'ink'
import { parseDebugArgs, DebugCollector, logProgress } from './debug.js'
import { parseTeammateArgs } from './teammate/teammateRuntime.js'
import { teammateAgent } from './agents/builtin/teammate.js'
import { SendMailTool } from './tools/sendmailtool.js'
import { CheckMailTool } from './tools/checkmailtool.js'
import { WorktreeManager } from './worktree/worktreeManager.js'
import type Anthropic from '@anthropic-ai/sdk'

// ── 解析 CLI 参数，决定运行模式：teammate TUI > debug > TUI ──────────────
const teammateOpts = parseTeammateArgs()
const debugOpts = parseDebugArgs()

// ── --worktree / -w: 启动时自动创建 worktree ──────────────────────────
// null = 未指定; undefined = 无 name（随机生成）; string = 指定 name
// 注意：会从 process.argv 中移除 --worktree 参数，避免后续 parser 误解析
function parseWorktreeArg(): string | null | undefined {
  const args = process.argv
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--worktree' || args[i] === '-w') {
      const hasValue = args[i + 1] && !args[i + 1].startsWith('-')
      const name = hasValue ? args[i + 1] : undefined
      args.splice(i, hasValue ? 2 : 1) // 从 argv 中移除，避免干扰 debug/teammate parser
      return name
    }
  }
  return null
}

const worktreeName = parseWorktreeArg()
if (worktreeName !== null && !teammateOpts) {
  const wm = WorktreeManager.getInstance()
  const r = wm.create(worktreeName)
  if (!r.success) {
    originalConsoleError(`[worktree] Failed: ${r.error}`)
    process.exit(1)
  }
  originalConsoleError(`[worktree] Working in: ${r.name} (${r.branch})`)
  originalConsoleError(`[worktree]   path: ${r.path}`)
  // 退出时提示 worktree 仍在，可复用
  const cleanup = () => {
    const st = wm.getStatus()
    if (st) {
      originalConsoleError(`\n[worktree] Worktree "${st.worktreeName}" still exists at ${st.worktreePath}`)
      originalConsoleError(`[worktree] Resume: --worktree ${st.worktreeName}`)
      originalConsoleError(`[worktree] Cleanup: node -e "require('./dist/worktree/worktreeManager.js').WorktreeManager.getInstance().exit(true)"`)
    }
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

if (teammateOpts) {
  // ════════════════════════════════════════════════════════════════════════
  // Teammate TUI 模式：独立进程，同套 Ink TUI，输入来自邮箱而非 stdin
  // ════════════════════════════════════════════════════════════════════════
  Mailbox.startWatching(teammateOpts.agentId)

  // 替换 mail 工具：用 teammate 的 agent_id 重新绑定，否则 LLM 会查 main 的邮箱
  const leaderId = teammateOpts.leaderId || 'main'
  toolRegistrar.removeTool('send_mail')
  toolRegistrar.removeTool('check_mail')
  toolRegistrar.registerTool(new SendMailTool(teammateOpts.agentId))
  toolRegistrar.registerTool(new CheckMailTool(teammateOpts.agentId, {
    popStrategy: 'teammatePriority',
    leaderId,
  }))

  const systemText = typeof teammateAgent.systemPrompt === 'function'
    ? await teammateAgent.systemPrompt({
        agent_id: teammateOpts.agentId,
        leader_id: teammateOpts.leaderId,
        role: teammateOpts.role,
        tools: teammateOpts.tools,
        peers: teammateOpts.peers,
        team_name: teammateOpts.teamName,
        task: '',
      }, {} as any)
    : ''

  const systemSegments: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemText },
  ]

  const wrappedRunTurn = (
    input: string | any[],
    signal?: AbortSignal,
    bgSignal?: AbortSignal,
  ) => runTurn(input, signal, bgSignal, systemSegments, undefined)  // teammate 不 drain mailbox（使用 check_mail 工具）

  const toolRenderMap = toolRegistrar.buildToolRenderMap()
  render(React.createElement(
    AppStateProvider,
    { store: appStateStore },
    React.createElement(App, {
      bridge,
      commandParser,
      runTurn: wrappedRunTurn,
      runBash,
      toolMap: toolRenderMap,
      mode: 'teammate' as const,
      teammateAgentId: teammateOpts.agentId,
      teammateLeaderId: teammateOpts.leaderId || 'main',
      enqueueUserMessage,
      enqueueMainMailboxWake,
      subscribeQueue,
      getQueueLength,
      dequeueMessage: drainQueue,
      initialMessages: initialTuiMessages,
    }),
  ))
} else {
  // ── Scheduler（TUI / debug 模式共用）────────────────────────────────────
  const scheduler = new Scheduler(
    prompt => runTurn(prompt),
    () => sessionState.agentRunning,
    bridge,
  )
  scheduler.start()

  if (debugOpts) {
  // ── Debug 模式：headless 运行，输出 JSON ──────────────────────────────

  // Restore originals: headless mode prints progress to stderr / JSON to stdout,
  // it has no TUI to bridge into.
  console.log = originalConsoleLog
  console.error = originalConsoleError

  // 启用 auto mode — debug 模式无 TUI，不能做交互式授权
  if (!bridge.autoMode) {
    bridge.toggleAutoMode()
    if (debugOpts.autoYes) {
      logProgress.start('Auto mode enabled')
    } else {
      logProgress.start('Auto mode enabled (required by headless debug mode; use --auto-yes to suppress this notice)')
    }
  }

  const collector = new DebugCollector(bridge)
  let aborted = false

  // Ctrl+C 优雅退出
  const onSigint = () => { aborted = true }
  process.on('SIGINT', onSigint)

  logProgress.start(`Starting headless turn: ${debugOpts.input.slice(0, 80)}${debugOpts.input.length > 80 ? '…' : ''}`)
  const signal = new AbortController()

  // 超时自动中断
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  if (debugOpts.timeout) {
    timeoutHandle = setTimeout(() => {
      signal.abort()
      logProgress.ok(`Timeout reached (${debugOpts.timeout}s), aborting...`)
    }, debugOpts.timeout * 1000)
  }

  try {
    await runTurn(debugOpts.input, signal.signal)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    collector.setError(msg)
    logProgress.error(msg)
  }

  // 清理超时定时器
  if (timeoutHandle) clearTimeout(timeoutHandle)

  if (aborted) {
    collector.setError('Interrupted by SIGINT')
    logProgress.error('Interrupted by user')
  }

  // ── 可选：等所有后台任务完成（--wait-for-bg）─────────────────────────
  // 主 turn 结束后立刻 buildResult 会丢失后台 leader/teammate 的最终输出，
  // 因为 onBackgroundAgentResult 还没把通知 push 进 messages。
  // 这里轮询 bgManager 直到所有 running 任务变成 terminal 状态。
  if (debugOpts.waitForBg && debugOpts.waitForBg > 0) {
    const waitMs = debugOpts.waitForBg * 1000
    const deadline = Date.now() + waitMs
    const initialRunning = bgManager.list().filter(t => t.status === 'running')
    if (initialRunning.length > 0) {
      logProgress.start(`Waiting for ${initialRunning.length} background task(s) (max ${debugOpts.waitForBg}s)...`)
      while (Date.now() < deadline) {
        const stillRunning = bgManager.list().filter(t => t.status === 'running')
        if (stillRunning.length === 0) break
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const final = bgManager.list().filter(t => t.status === 'running')
      if (final.length > 0) {
        logProgress.error(`Timed out waiting for ${final.length} background task(s) after ${debugOpts.waitForBg}s`)
      } else {
        logProgress.ok('All background tasks completed')
      }
    }
  }

  // 从 messages 数组构建输出
  const result = collector.buildResult(sessionState.messages as Array<{ role: string; content: string | Array<unknown> }>)

  const output = JSON.stringify(result, null, 2)

  if (debugOpts.output) {
    // 写文件
    const fs = await import('fs')
    fs.writeFileSync(debugOpts.output, output + '\n')
    logProgress.ok(`Result written to ${debugOpts.output}`)
  } else {
    // 写 stdout
    // 注意：console.log 已被 override 到 bridge.emitMessage，这里必须用
    // process.stdout.write 或原始 console.log 才能让 JSON 到 stdout。
    // 详见 agent.ts 顶部 console.log 的 override 逻辑。
    console.error('─'.repeat(40))
    process.stdout.write(output + '\n')
  }

  // 清理并退出
  scheduler.stop()
  transcriptRecorder.closeSession()
  await mcpManager.shutdownAll().catch(() => {})
  process.exit(result.status === 'error' ? 1 : 0)
} else {
  // ── 正常 TUI 模式 ─────────────────────────────────────────────────────
  // 启动主 agent 邮箱监听（轮询模式），使 background teammate 的跨进程邮件
  // 能被及时感知，通过 Mailbox.subscribe → MessageQueue → processQueue 链路自动处理
  Mailbox.startWatching('main')

  // subscribeMainMailbox — 桥接 Mailbox 事件到 TUI 的消息队列。
  // Mailbox.startWatching 负责跨进程轮询，Mailbox.subscribe 负责进程内/跨进程事件监听。
  // 两者配合：startWatching 扫描 inbox → deliverIfNew → emit → subscribe 回调 →
  // enqueueMainMailboxWake → processQueue → drainMailbox → LLM 处理邮件。
  const subscribeMainMailbox = (listener: () => void) => Mailbox.subscribe('main', listener)
  const hasUnreadMainMail = () => Mailbox.hasUnread('main')

  const toolRenderMap = toolRegistrar.buildToolRenderMap()
  render(React.createElement(
    AppStateProvider,
    { store: appStateStore },
    React.createElement(App, {
      bridge,
      commandParser,
      runTurn,
      runBash,
      toolMap: toolRenderMap,
      enqueueUserMessage,
      enqueueMainMailboxWake,
      subscribeQueue,
      subscribeMainMailbox,
      hasUnreadMainMail,
      getQueueLength,
      dequeueMessage: drainQueue,
      initialMessages: initialTuiMessages,
    }),
  ))
}
}
