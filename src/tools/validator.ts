import { z } from 'zod'
import type { Tool } from './tool.js'

/**
 * Per-tool input + output validator using zod.
 *
 * Why both directions:
 *  - input: the model occasionally calls tools with missing/wrong-typed fields.
 *    We catch it before dispatch and return a structured error the LLM can
 *    self-correct from, instead of letting the tool implementation crash.
 *  - output: a tool that breaks its own contract (e.g. EditTool returning bad
 *    JSON, an agent finalize() returning the wrong shape) silently corrupts
 *    downstream state. Validating output catches this in dev and is logged
 *    in prod without blocking the response.
 *
 * Tools migrate gradually: those without `inputSchemaZod` skip input
 * validation (e.g. MCP-wrapped tools whose schema comes from the remote
 * server). Output defaults to `z.string()` because every Tool.execute()
 * currently returns string — tools that return structured data (JSON-encoded
 * strings) can override `outputSchemaZod` with a stricter schema.
 */

export interface ValidationResult {
  ok: boolean
  /** Human-readable error suitable for handing back to the LLM. */
  error?: string
}

export function validateInput(tool: Tool, input: unknown): ValidationResult {
  const schema = tool.inputSchemaZod
  if (!schema) return { ok: true }

  const result = schema.safeParse(input)
  if (result.success) return { ok: true }

  return { ok: false, error: formatError(tool.name, 'input', result.error) }
}

export function validateOutput(tool: Tool, output: unknown): ValidationResult {
  const schema = tool.outputSchemaZod
  if (!schema) return { ok: true }

  const result = schema.safeParse(output)
  if (result.success) return { ok: true }

  return { ok: false, error: formatError(tool.name, 'output', result.error) }
}

function formatError(toolName: string, kind: 'input' | 'output', err: z.ZodError): string {
  const lines = err.issues.map(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `  - ${path}: ${issue.message}`
  })
  return [`Invalid ${kind} for tool "${toolName}":`, ...lines].join('\n')
}
