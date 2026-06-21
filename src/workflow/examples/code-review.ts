import type { WorkflowMeta } from '../types.js'

// ---------------------------------------------------------------------------
// Workflow metadata
// ---------------------------------------------------------------------------

export const meta: WorkflowMeta = {
  name: 'code-review',
  description: 'Multi-dimensional code review: bugs, security, and performance',
  phases: [
    { title: 'Review' },
    { title: 'Verify' },
  ],
  whenToUse: 'Run against a git diff or a set of changed files to get structured findings across three review dimensions.',
}

// ---------------------------------------------------------------------------
// Workflow script
// The script string is evaluated inside the workflow runtime, which injects
// the globals: agent(), pipeline(), log(), args, budget
// ---------------------------------------------------------------------------

export const script: string = `
const DIMENSIONS = [
  {
    key: 'bugs',
    prompt: \`You are a senior software engineer performing a code review focused exclusively on correctness bugs.
Analyse the following code (or diff) and identify concrete bugs: logic errors, off-by-one mistakes,
null/undefined dereferences, incorrect error handling, race conditions, or any other defect that would
cause incorrect runtime behaviour. Do NOT report style issues or optimisation opportunities.

Code to review:
\${args?.code ?? '(no code provided — describe what you would check)'}

Return a JSON object with a single key "issues" whose value is an array of strings.
Each string should be one self-contained finding in the format:
  "[file:line] Short description of the bug and why it is wrong."
If no bugs are found return { "issues": [] }.\`,
  },
  {
    key: 'security',
    prompt: \`You are a security engineer performing a code review focused exclusively on security vulnerabilities.
Analyse the following code (or diff) and identify concrete security issues: injection flaws (SQL, command,
XSS), insecure deserialization, broken authentication or authorisation, sensitive data exposure, use of
weak cryptography, path traversal, or any other OWASP-class vulnerability.

Code to review:
\${args?.code ?? '(no code provided — describe what you would check)'}

Return a JSON object with a single key "issues" whose value is an array of strings.
Each string should be one self-contained finding in the format:
  "[file:line] Short description of the vulnerability, the attack vector, and suggested remediation."
If no security issues are found return { "issues": [] }.\`,
  },
  {
    key: 'perf',
    prompt: \`You are a performance engineer performing a code review focused exclusively on performance problems.
Analyse the following code (or diff) and identify concrete performance issues: unnecessary re-renders,
N+1 query patterns, missing indexes, expensive operations inside hot loops, memory leaks, unbounded
caches, or any other pattern that would cause measurable latency or resource waste under realistic load.

Code to review:
\${args?.code ?? '(no code provided — describe what you would check)'}

Return a JSON object with a single key "issues" whose value is an array of strings.
Each string should be one self-contained finding in the format:
  "[file:line] Short description of the performance issue and a suggested improvement."
If no performance issues are found return { "issues": [] }.\`,
  },
]

const schema = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['issues'],
}

// Fan out across all three dimensions in parallel
const results = await pipeline(
  DIMENSIONS,
  async (dim) => {
    const result = await agent(dim.prompt, {
      label: \`Review: \${dim.key}\`,
      phase: 'Review',
      schema,
    })
    return { key: dim.key, issues: result.issues }
  }
)

// Log findings per dimension
const combined = {}
for (const { key, issues } of results) {
  log(\`[\${key}] \${issues.length} finding(s)\`)
  for (const issue of issues) {
    log(\`  • \${issue}\`)
  }
  combined[key] = issues
}

// Verify step — summarise overall risk
const allIssues = results.flatMap(r => r.issues)
if (allIssues.length > 0) {
  const verifyPrompt = \`You are a lead engineer reviewing a set of code-review findings.
Given the following findings, produce a brief risk summary (2-4 sentences) and suggest a priority order for fixing them.

Findings:
\${allIssues.map((issue, i) => \`\${i + 1}. \${issue}\`).join('\\n')}

Return a JSON object: { "issues": ["<risk summary>", "<priority order>"] }\`

  const summary = await agent(verifyPrompt, {
    label: 'Risk summary',
    phase: 'Verify',
    schema,
  })

  log('[verify] risk summary:')
  for (const line of summary.issues) {
    log(\`  \${line}\`)
  }

  combined['summary'] = summary.issues
}

return combined
`

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { runWorkflow } = await import('../index.js')

  const rawArgs = process.argv.slice(2)

  // Simple arg parsing: --code=<inline code> or --file=<path>
  let code: string | undefined
  let resumeFromRunId: string | undefined
  let model: string | undefined

  for (const arg of rawArgs) {
    const codeMatch = arg.match(/^--code=(.+)$/)
    if (codeMatch) { code = codeMatch[1]; continue }

    const fileMatch = arg.match(/^--file=(.+)$/)
    if (fileMatch) {
      const { readFileSync } = await import('fs')
      const { resolve } = await import('path')
      code = readFileSync(resolve(fileMatch[1]), 'utf-8')
      continue
    }

    const resumeMatch = arg.match(/^--resume=(.+)$/)
    if (resumeMatch) { resumeFromRunId = resumeMatch[1]; continue }

    const modelMatch = arg.match(/^--model=(.+)$/)
    if (modelMatch) { model = modelMatch[1]; continue }
  }

  if (!code) {
    console.log('Usage: tsx code-review.ts --file=<path> [--model=<model>] [--resume=<runId>]')
    console.log('       tsx code-review.ts --code="<inline code snippet>"')
    process.exit(1)
  }

  const result = await runWorkflow({
    script,
    args: { code },
    resumeFromRunId,
    model,
  })

  console.log('[code-review] completed, runId:', result.runId)
  console.log('[code-review] output tokens:', result.outputTokens)
  console.log('[code-review] findings:', JSON.stringify(result.returnValue, null, 2))
}
