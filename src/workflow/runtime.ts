// Workflow runtime — 用 myagent 自身的 runAgent() 派生子 agent，不直接调 SDK

import { randomUUID } from 'crypto'
import { runAgent } from '../agents/runner.js'
import type { AgentDefinition } from '../agents/definition.js'
import { modelConfig } from '../llm/model-config.js'
import { Journal, agentKey } from './journal.js'
import { createGlobalPool, type Semaphore } from './semaphore.js'
import { workflowRegistry } from './registry.js'
import type { AgentOpts, WorkflowBudget, WorkflowRunOptions, WorkflowRunResult } from './types.js'

export async function runWorkflow(options: WorkflowRunOptions): Promise<WorkflowRunResult> {
  const script = options.script ?? ''
  const ctx = options.ctx
  const defaultModel = options.model ?? modelConfig.getCurrent()
  const semaphore: Semaphore = createGlobalPool()

  // ── Journal（可恢复性） ───────────────────────────────────────────────────
  let runId: string
  let journal: Journal

  if (options.resumeFromRunId) {
    runId = options.resumeFromRunId
    journal = new Journal(runId, options.journalDir)
    journal.load()
  } else {
    runId = options.runId ?? ('wf_' + randomUUID().slice(0, 8))
    journal = new Journal(runId, options.journalDir)
  }

  // registry 登记（resume 时更新状态为 running）
  workflowRegistry.start(runId, options.scriptPath)

  // ── Token 计数 ────────────────────────────────────────────────────────────
  let spentTokens = 0
  const tokenBudgetTotal: number | null = options.tokenBudget ?? null

  // ── 进度 ─────────────────────────────────────────────────────────────────
  let currentPhase = ''

  // workflow 内部进度既写 emitLine（聊天区系统消息），
  // 也推 onSubAgentDelta（让 run_workflow 工具卡的 liveOutput 实时更新）
  const WORKFLOW_DELTA_NAME = `workflow:${runId}`
  function emitProgress(msg: string): void {
    ctx.emitLine(msg)
    ctx.onSubAgentDelta?.(WORKFLOW_DELTA_NAME, msg + '\n')
  }

  function log(msg: string): void {
    const prefix = currentPhase ? `[${currentPhase}] ` : ''
    emitProgress(prefix + msg)
    workflowRegistry.appendLog(runId, prefix + msg)
  }

  function phase(title: string): void {
    currentPhase = title
    emitProgress(`── phase: ${title}`)
    workflowRegistry.setPhase(runId, title)
  }

  // ── agent() ───────────────────────────────────────────────────────────────
  async function agent(prompt: string, opts?: AgentOpts): Promise<unknown> {
    const key = agentKey(prompt, opts)

    // Journal 缓存命中 → 直接返回
    if (journal.has(key)) {
      const cachedLabel = opts?.label ?? prompt.slice(0, 40).replace(/\n/g, ' ')
      emitProgress(`[workflow] cache hit: ${cachedLabel.slice(0, 60)}`)
      workflowRegistry.agentDone(runId, cachedLabel, true)
      return journal.get(key)
    }

    await semaphore.acquire()

    try {
      if (tokenBudgetTotal !== null && spentTokens >= tokenBudgetTotal) {
        throw new Error('Token budget exceeded')
      }

      const label = opts?.label ?? prompt.slice(0, 40).replace(/\n/g, ' ')
      emitProgress(`[workflow] agent: ${label}`)
      ctx.onSubAgentStart?.(label, prompt.slice(0, 80), 'workflow')
      workflowRegistry.agentStart(runId, label)

      // 构建 AgentDefinition：把 prompt 作为 system，task 作为 user message
      // 默认给文件系统只读工具，caller 可通过 opts.tools 覆盖（传 [] 表示无工具）
      const DEFAULT_TOOLS = ['read_file', 'list_dir', 'bash', 'grep', 'glob', 'web_search', 'web_fetch']
      const explicitTools = opts?.tools
      const tools = explicitTools ?? DEFAULT_TOOLS
      const noTools = tools.length === 0

      const def: AgentDefinition = {
        name: `workflow:${label.slice(0, 20)}`,
        description: 'Workflow sub-agent',
        agentType: 'workflow',
        systemPrompt: opts?.schema
          ? `You are a workflow sub-agent. You MUST respond ONLY with a raw JSON object that strictly conforms to this schema (no markdown, no commentary):\n${JSON.stringify(opts.schema, null, 2)}`
          : noTools
            ? 'You are a workflow sub-agent. You have NO tools available. Respond with text analysis only — do NOT reference, call, or suggest any tool names.'
            : 'You are a workflow sub-agent. Use the available tools to complete the task. Be concise and accurate.',
        tools,
        model: opts?.model ?? defaultModel,
        maxTurns: opts?.tools ? 10 : 20,
        formatUserMessage: async () => prompt,
      }

      const agentCtx = {
        ...ctx,
        source: `workflow:${runId}`,
        // 进度统计：累计 output tokens 到 spentTokens
        onSubAgentProgress: (name: string, _toolUseCount: number, tokenCount: number) => {
          // tokenCount 是累计值，每次取最新值（非 delta）
          ctx.onSubAgentProgress?.(name, _toolUseCount, tokenCount)
        },
      }

      let rawResult = await runAgent(def, { task: prompt }, agentCtx)
      workflowRegistry.agentDone(runId, label)

      // schema 模式：解析 JSON，最多重试 3 次
      if (opts?.schema) {
        let parsed: unknown
        let lastText = rawResult
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            parsed = JSON.parse(lastText)
            break
          } catch {
            if (attempt < 2) {
              // 重跑，追加纠正提示
              const retry: AgentDefinition = {
                ...def,
                formatUserMessage: async () =>
                  `${prompt}\n\nYour previous response could not be parsed as JSON. Respond ONLY with valid JSON, no markdown fences.`,
              }
              lastText = await runAgent(retry, { task: prompt }, agentCtx)
            }
          }
        }
        if (parsed === undefined) {
          throw new Error(
            `workflow agent() failed to produce valid JSON after 3 attempts. Last: ${lastText.slice(0, 200)}`,
          )
        }
        rawResult = JSON.stringify(parsed)
        journal.set(key, parsed)
        return parsed
      }

      journal.set(key, rawResult)
      return rawResult
    } finally {
      semaphore.release()
    }
  }

  // ── pipeline() ────────────────────────────────────────────────────────────
  async function pipeline(
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
  ): Promise<unknown[]> {
    return Promise.all(
      items.map((item, index) =>
        stages.reduce(
          (chain, stage) => chain.then(prev => stage(prev, item, index)),
          Promise.resolve(item as unknown),
        ),
      ),
    )
  }

  // ── parallel() ────────────────────────────────────────────────────────────
  async function parallel(thunks: Array<() => Promise<unknown>>): Promise<Array<unknown>> {
    const results = await Promise.allSettled(thunks.map(t => t()))
    return results.map(r => (r.status === 'fulfilled' ? r.value : null))
  }

  // ── budget ────────────────────────────────────────────────────────────────
  const budget: WorkflowBudget = {
    total: tokenBudgetTotal,
    spent(): number { return spentTokens },
    remaining(): number {
      return tokenBudgetTotal !== null ? Math.max(0, tokenBudgetTotal - spentTokens) : Infinity
    },
  }

  // ── 执行脚本 ──────────────────────────────────────────────────────────────
  const context = { agent, pipeline, parallel, phase, log, args: options.args ?? {}, budget }

  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(context), 'return (async()=>{' + script + '})()')
  try {
    const returnValue: unknown = await fn(...Object.values(context))
    workflowRegistry.complete(runId)
    return { runId, returnValue, outputTokens: spentTokens }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    workflowRegistry.fail(runId, msg)
    throw err
  }
}
