import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js'
import { recallRelevantMemory } from './memory/recall.js'
import { extractMemoryFromTurn, appendMemories } from './memory/extract.js'
import { runAgentLoopStream, UsageAccum, type RunAgentLoopResult } from './utils/runagent.js'
import {
  saveBackgroundResult,
  buildBgNotification,
} from './utils/backgroundStorage.js'
import { handleMCPCommand } from './commands/mcpcommand.js'
import {
  bridge,
  client,
  toolRegistrar,
  hookManager,
  sessionState,
  sessionManager,
  transcriptRecorder,
  agentTool,
  skillManager,
  agentRegistry,
  attachmentQueue,
  bgManager,
  ttsService,
  modelConfig,
  mcpManager,
  lspManager,
  turnState,
  MAX_TURNS,
  escapeForTag,
  executeTool,
  drainQueue,
  drainMailbox,
  buildSystemSegments,
  compactIfNeeded,
  extractRecallText,
  extractBgDescription,
  summarizeConclusion,
} from './bootstrap.js'
import { appStateStore } from './state/appState.js'
import { PlanModeAttachment } from './attachment/planMode.js'
import { IDEDiagnosticsAttachment, IDESelectionAttachment } from './attachment/ide.js'

// ── Plan mode: 控制 prompt 注入频率（每 5 次 query 注入完整版）──────
const PLAN_MODE_FULL_PROMPT_INTERVAL = 5

// ── Agent turn state ──────────────────────────────────────────────────────────
let currentTurnTail: Promise<void> = Promise.resolve()

// ── ! 命令：执行 bash / !mcp 并推入 messages (Claude Code 模式) ───
// 复用 toolRegistry 中的 BashTool（和 LLM 调用的同个工具），而非另起 execSync。
// 结果以 XML 标签格式推入 messages 供后续 LLM 回合引用，本身不触发 LLM query。
// !mcp 命令被拦截路由到 MCP 命令处理器。
export async function runBash(cmd: string): Promise<string> {
  // !mcp 命令拦截
  if (cmd.trim().toLowerCase().startsWith('mcp')) {
    const args = cmd.trim().slice(3).trim()
    const result = await handleMCPCommand(args, mcpManager)
    sessionState.appendMessages(
      { role: 'user', content: `<mcp-cmd>${escapeForTag(args)}</mcp-cmd>` },
      { role: 'user', content: `<mcp-result>\n${escapeForTag(result)}\n</mcp-result>` },
    )
    return result
  }

  const tool = toolRegistrar.getTool('bash')
  if (!tool) return 'Error: Bash tool not found'
  // 跳过权限检查：用户主动输入 ! 命令即已授权
  const result = await tool.execute({ command: cmd })
  sessionState.appendMessages(
    { role: 'user', content: `<bash-input>${escapeForTag(cmd)}</bash-input>` },
    { role: 'user', content: `<bash-stdout>${escapeForTag(result)}</bash-stdout>` },
  )
  return result
}

export async function runTurn(
  input: string | Array<ContentBlockParam>,
  signal?: AbortSignal,
  backgroundSignal?: AbortSignal,
  systemSegments?: Anthropic.TextBlockParam[],
  /** 要 drain 的邮箱 agent ID，默认 'main'。teammate 应传 undefined 跳过 drain。 */
  mailboxAgentId: string | undefined = 'main',
): Promise<{ backgrounded?: boolean } | void> {
  // Serialize turns by awaiting the tail of the queue, then making *this* call's
  // body the new tail. Replaces a 200ms polling loop on `agentRunning`.
  const previous = currentTurnTail
  let releaseTail: () => void = () => {}
  currentTurnTail = new Promise<void>(resolve => { releaseTail = resolve })
  await previous

  sessionState.setRunning(true)
  turnState.currentAbortSignal = signal
  agentTool.setSignal(signal)

  try {
    sessionState.appendMessage({ role: 'user', content: input } as Anthropic.MessageParam)

    // Transcript: set main agent context + record user input
    transcriptRecorder.pushAgentContext('main', null)
    transcriptRecorder.recordUserInput(input as string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam>)

    // Recall once per user input (not per inner turn)
    const recallText = extractRecallText(input as string | Array<ContentBlockParam>)
    bridge.emitStatus('召回相关记忆...')
    const relevantMemory = await recallRelevantMemory(recallText)
    if (relevantMemory) bridge.emitRecall(relevantMemory)
    bridge.emitStatus(relevantMemory ? '找到相关记忆' : 'thinking...')

    const buildSystem = (): Anthropic.TextBlockParam[] => systemSegments ?? buildSystemSegments(relevantMemory)

    // 预拉取 VSCode 诊断（fire-and-forget，不阻塞 turn 启动）
    mcpManager.fetchVSCodeDiagnostics().catch(() => {})

    // Accumulate text across inner turns for memory extraction (one pass per user input, not per inner turn)
    let fullAssistantText = ''
    // Track the latest stop_reason per LLM round for transcript
    let lastStopReason: string | undefined

    const loopResult = await runAgentLoopStream({
      client,
      model: modelConfig.getCurrent(),
      system: buildSystem,
      tools: toolRegistrar.getAllTools(),
      messages: sessionState.messages,
      maxTurns: MAX_TURNS,
      executeTool,
      parallelSafeTools: toolRegistrar.getParallelSafeNames(),
      signal,
      backgroundSignal,
      drainQueue: () => drainQueue(),
      drainAttachments: () => {
        const currentMode = appStateStore.getState().mode
        if (currentMode === 'plan') {
          let count = appStateStore.getState().planQueryCount
          count++
          appStateStore.setState(prev => ({ ...prev, planQueryCount: count }))
          if (count === 1) {
            process.stderr.write(`[planMode] count=1 skip (relying on EnterPlanModeTool FULL)\n`)
          }
          if (count > 1) {
            const isFullPrompt = count % PLAN_MODE_FULL_PROMPT_INTERVAL === 0
            attachmentQueue.enqueue(new PlanModeAttachment(isFullPrompt))
          }
        }

        // VSCode 诊断 → Attachment（带去重）
        const vscodeDiags = mcpManager.getVSCodeDiagnosticsAndClear()
        if (vscodeDiags) {
          attachmentQueue.enqueue(new IDEDiagnosticsAttachment(vscodeDiags))
        }

        // IDE 选中 → Attachment（带去重）
        const ideSelection = mcpManager.getIDESelectionAndClear()
        if (ideSelection) {
          attachmentQueue.enqueue(new IDESelectionAttachment(
            ideSelection.filePath,
            ideSelection.startLine,
            ideSelection.endLine,
            ideSelection.text,
          ))
        }

        // 统一 drain：队列中的 Attachment + LSP 诊断（LSP 暂保持裸文本）
        let result = attachmentQueue.formatDrain()
        const diags = lspManager?.getDiagnostics()
        if (diags) {
          const diagBlock = `[lsp] diagnostics:\n${diags}`
          result = result ? `${result}\n${diagBlock}` : `[System State Changes]\n${diagBlock}`
        }
        return result
      },
      drainMailbox: () => drainMailbox(mailboxAgentId),
      onLLMRequest: (model, turn, msgs) => {
        transcriptRecorder.recordLLMRequest(model, turn, msgs)
      },
      onText: delta => {
        bridge.emitText(delta)
        ttsService.feed(delta)
      },
      onTurnEnd: async (text, msgs) => {
        fullAssistantText += text + '\n'
        bridge.emitTurnEnd(text)
        ttsService.flush()
        if (sessionState.lastUsage && text) {
          transcriptRecorder.recordLLMResponseEnd(text, sessionState.lastUsage, lastStopReason)
        }
        sessionManager.recordCheckpoint(msgs)
        await hookManager.runOnTurnEnd({
          messages: msgs,
          assistantText: text,
          userInput: recallText,
        })
      },
      onToolStart: (callId, name, input) => {
        bridge.emitToolStart(callId, name, input)
        transcriptRecorder.recordToolStart(callId, name, input)
      },
      onToolEnd: (callId, name, input, output) => {
        bridge.emitToolEnd(callId, name, input, output)
        transcriptRecorder.recordToolEnd(callId, name, input, output)
        sessionManager.recordToolCall()
      },
      onTurnToolReset: () => bridge.emitTurnToolReset(),
      onUsage: stats => {
        sessionState.setUsage(stats)
        sessionManager.recordTurn(stats)
        bridge.emitUsage(stats)
      },
    })

    // ── Background handoff ─────────────────────────────────────────────────
    if (loopResult.backgrounded && loopResult.fork) {
      const { messages: forkedMessages, usage: forkedUsage } = loopResult.fork
      const taskDescription = extractBgDescription(forkedMessages)
      const { id: taskId, abortController } = bgManager.start(taskDescription)
      bridge.emitBackgroundStart()
      // Transcript: pop main context, record handoff, push bg context
      transcriptRecorder.popAgentContext()
      transcriptRecorder.recordBackgroundHandoff(taskId, forkedMessages.length)
      transcriptRecorder.pushAgentContext(taskId, 'main')
      // Fork a background loop that runs independently (no await).
      // Background uses the same executeTool (hooks still fire — permission prompts work).
      // UI callbacks are no-ops: outputs don't render in the main TUI area.
      // Capture the final turn's conclusion text for the completion message.
      let backgroundConclusion = ''
      let bgLastUsage: UsageAccum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      runAgentLoopStream({
        client,
        model: modelConfig.getCurrent(),
        system: buildSystem,
        tools: toolRegistrar.getAllTools(),
        messages: forkedMessages,
        maxTurns: MAX_TURNS,
        executeTool,
        parallelSafeTools: toolRegistrar.getParallelSafeNames(),
        signal: abortController.signal,           // 支持 /bg kill
        onLLMRequest: (model, turn, msgs) => {
          transcriptRecorder.recordLLMRequest(model, turn, msgs)
        },
        // No drain — background doesn't consume foreground message queue
        // No backgroundSignal — background runs independently (Ctrl+B won't re-fork)
        onText: () => {}, // no-op: no streaming text for background
        onTurnEnd: (text) => {
          if (text) backgroundConclusion = text // capture final conclusion
          // Transcript: record the background LLM response
          if (bgLastUsage && text) {
            transcriptRecorder.recordLLMResponseEnd(text, bgLastUsage, undefined)
          }
          transcriptRecorder.recordCheckpoint(forkedMessages)
        },
        onToolStart: (callId, name, input) => {
          transcriptRecorder.recordToolStart(callId, name, input)
        },
        onToolEnd: (callId, name, input, output) => {
          transcriptRecorder.recordToolEnd(callId, name, input, output)
        },
        onTurnToolReset: () => {},
        onUsage: (stats) => { bgLastUsage = stats },
      }).then(() => {
        transcriptRecorder.popAgentContext()
        bridge.emitBackgroundEnd()
        const taskInfo = bgManager.get(taskId)
        // 已被用户手动 kill 的，不推送 completion 通知
        if (taskInfo?.status === 'killed') return
        // 1. 全量结论写文件
        const outputPath = saveBackgroundResult(taskId, taskDescription, backgroundConclusion)
        // 2. 构造摘要（取结论的前 200 字符作为摘要行）
        const summary = summarizeConclusion(backgroundConclusion, taskDescription)
        bgManager.complete(taskId, outputPath, summary)
        // 3. 轻量 XML 通知推入 messages（LLM 可见）
        const relativePath = path.relative(process.cwd(), outputPath)
        const notification = buildBgNotification(taskId, 'completed', summary, relativePath)
        sessionState.appendMessage({ role: 'user', content: notification })
        // 4. TUI 只显示一行简短提示
        bridge.emitMessage('system', `[BG] √ ${taskDescription} → ${relativePath}`)
        // 5. 触发 goal 检查（background 完成后的验证，fire-and-forget）
        hookManager.runOnLoopEnd({
          messages: sessionState.messages,
          assistantText: backgroundConclusion,
          userInput: taskDescription,
        }).catch(err => console.error('[goal] bg check error:', err))
      }).catch((err: unknown) => {
        transcriptRecorder.popAgentContext()
        bridge.emitBackgroundEnd()
        const msg = err instanceof Error ? err.message : String(err)
        // 失败时也写入文件（含错误信息）
        const outputPath = saveBackgroundResult(taskId, taskDescription, `Error: ${msg}`)
        bgManager.fail(taskId, msg, outputPath)
        const notification = buildBgNotification(taskId, 'failed', taskDescription, `.myagent/background/${taskId}.md`, msg)
        sessionState.appendMessage({ role: 'user', content: notification })
        bridge.emitMessage('system', `[BG] ✗ ${taskDescription}: ${msg}`)
      })

      return { backgrounded: true }
    }

    // ── Normal path (not backgrounded) ─────────────────────────────────────
    // Notify hooks that the loop has ended (goal check, etc.)
    console.error('[turn] about to call hookManager.runOnLoopEnd, fullAssistantText length=', fullAssistantText.length)
    await hookManager.runOnLoopEnd({
      messages: sessionState.messages,
      assistantText: fullAssistantText,
      userInput: recallText,
    })

    // Extract memories once per user input (not per inner turn)
    if (fullAssistantText.trim()) {
      extractMemoryFromTurn(recallText, fullAssistantText)
        .then(async items => {
          if (items.length === 0) return
          const added = await appendMemories(items)
          if (added > 0) {
            bridge.emitMessage('system', `[memory] +${added} new memor${added === 1 ? 'y' : 'ies'}`)
          }
        })
        .catch(err => console.error('[extract]', err))
    }

    await compactIfNeeded()
  } finally {
    // Transcript: pop main agent context
    transcriptRecorder.popAgentContext()
    sessionState.setRunning(false)
    releaseTail()
  }
}
