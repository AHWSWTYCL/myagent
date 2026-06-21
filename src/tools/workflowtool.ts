import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { Tool, type ToolRenderHeader } from './tool.js'
import { runWorkflow } from '../workflow/runtime.js'
import type { AgentRunContext } from '../agents/definition.js'

const SCRIPTS_DIR = path.join(os.homedir(), '.myagent', 'workflow-scripts')

function saveScript(runId: string, scriptBody: string, sourceLabel: string): string {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
  const filePath = path.join(SCRIPTS_DIR, `${runId}.js`)
  const header = `// runId: ${runId}\n// source: ${sourceLabel}\n// saved: ${new Date().toISOString()}\n\n`
  fs.writeFileSync(filePath, header + scriptBody, 'utf-8')
  return filePath
}

export class WorkflowTool extends Tool {
  private ctx?: AgentRunContext

  inject(ctx: AgentRunContext): void {
    this.ctx = ctx
  }

  get name() { return 'run_workflow' }

  get description() {
    return `Run a dynamic multi-agent workflow script. The script body has access to:
- agent(prompt, opts?) — spawn a sub-agent. By default gets read_file, list_dir, bash, grep, glob, web_search, web_fetch. Pass opts.tools=[] to disable all tools, or opts.tools=['bash','write_file'] to customize.
- pipeline(items, ...stages) — process items through stages without a global barrier (DEFAULT)
- parallel(thunks) — run thunks concurrently, wait for all (use only when you need all results together)
- phase(title) — label the current progress group
- log(msg) — emit a progress message
- args — the value passed in the args field
- budget — { total, spent(), remaining() }

Scripts are plain JavaScript (no TypeScript). Use await freely. Return a value to get it back.
Every run is persisted to ~/.myagent/workflow-scripts/<runId>.js before execution.

Example:
  phase('Scan')
  const bugs = await agent('Find bugs in src/', { label: 'scanner' })
  return bugs`
  }

  get inputSchemaZod() {
    return z.object({
      script: z.string().optional().describe('JavaScript workflow script body (mutually exclusive with script_path)'),
      script_path: z.string().optional().describe('Path to a .js workflow script file (mutually exclusive with script)'),
      args: z.unknown().optional().describe('Value exposed as `args` inside the script'),
      resume_from_run_id: z.string().optional().describe('Resume a previous run: cache-hit agent() calls return instantly'),
      model: z.string().optional().describe('Default model for sub-agents (inherits session model if omitted)'),
      token_budget: z.number().int().positive().optional().describe('Max output tokens across all sub-agents'),
    })
  }

  async checkPermission(): Promise<import('./tool.js').ToolPermissionResult> {
    return { action: 'continue' }
  }

  renderHeader(input: Record<string, unknown>): ToolRenderHeader {
    const src = (input.script_path as string | undefined) ?? 'inline script'
    return { label: 'Workflow', args: src }
  }

  async execute(input: Record<string, unknown>, _signal?: AbortSignal): Promise<string> {
    if (!this.ctx) {
      return 'Error: WorkflowTool not initialized — call inject(ctx) first'
    }

    const parsed = this.inputSchemaZod!.safeParse(input)
    if (!parsed.success) {
      return `Error: invalid input — ${parsed.error.message}`
    }

    const { script, script_path, args, resume_from_run_id, model, token_budget } = parsed.data

    // ── 决定 runId（resume 复用旧 id，否则新建） ────────────────────────────
    const runId = resume_from_run_id ?? ('wf_' + randomUUID().slice(0, 8))

    // ── 解析脚本内容 ─────────────────────────────────────────────────────────
    let scriptBody: string
    let sourceLabel: string

    if (script_path) {
      if (!fs.existsSync(script_path)) {
        return `Error: script file not found: ${script_path}`
      }
      scriptBody = fs.readFileSync(script_path, 'utf-8')
      // strip export const meta = {...} preamble if present
      scriptBody = scriptBody.replace(/^export\s+const\s+meta\s*=\s*\{[\s\S]*?\}\s*;?\s*/m, '')
      sourceLabel = script_path
    } else if (script) {
      scriptBody = script
      sourceLabel = 'inline'
    } else {
      return 'Error: provide either script or script_path'
    }

    // ── 持久化脚本（resume 时跳过，已有文件） ────────────────────────────────
    let savedPath: string
    const existingPath = path.join(SCRIPTS_DIR, `${runId}.js`)
    if (resume_from_run_id && fs.existsSync(existingPath)) {
      savedPath = existingPath
      this.ctx.emitLine(`[workflow] resuming ${runId}, script: ${savedPath}`)
    } else {
      savedPath = saveScript(runId, scriptBody, sourceLabel)
      this.ctx.emitLine(`[workflow] script saved: ${savedPath}`)
    }

    // ── 执行 ─────────────────────────────────────────────────────────────────
    try {
      const result = await runWorkflow({
        ctx: this.ctx,
        script: scriptBody,
        runId,
        scriptPath: savedPath,
        args,
        resumeFromRunId: resume_from_run_id,
        model,
        tokenBudget: token_budget,
      })

      const returnStr = result.returnValue === undefined
        ? '(no return value)'
        : typeof result.returnValue === 'string'
          ? result.returnValue
          : JSON.stringify(result.returnValue, null, 2)

      return `runId: ${result.runId}\nscript: ${savedPath}\n\n${returnStr}`
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
