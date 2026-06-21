import { runWorkflow } from './runtime.js'
import { WorkflowRunOptions } from './types.js'
import fs from 'fs'
import path from 'path'

export async function runWorkflowFile(
  scriptPath: string,
  opts?: Partial<WorkflowRunOptions>
): Promise<void> {
  const script = fs.readFileSync(path.resolve(scriptPath), 'utf-8')
  const result = await runWorkflow({ script, scriptPath, ...opts })
  console.log('[workflow] completed, runId:', result.runId)
  console.log('[workflow] output tokens:', result.outputTokens)
  if (result.returnValue !== undefined) {
    console.log('[workflow] result:', JSON.stringify(result.returnValue, null, 2))
  }
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const scriptPath = args[0]

  if (!scriptPath || scriptPath.startsWith('--')) {
    console.log('Usage: workflow-runner <script-path> [--resume=<runId>] [--model=<model>]')
    process.exit(1)
  }

  let resumeFromRunId: string | undefined
  let model: string | undefined

  for (const arg of args.slice(1)) {
    const resumeMatch = arg.match(/^--resume=(.+)$/)
    if (resumeMatch) {
      resumeFromRunId = resumeMatch[1]
      continue
    }
    const modelMatch = arg.match(/^--model=(.+)$/)
    if (modelMatch) {
      model = modelMatch[1]
    }
  }

  await runWorkflowFile(scriptPath, { resumeFromRunId, model })
}
