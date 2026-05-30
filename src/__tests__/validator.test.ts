import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { validateInput, validateOutput } from '../tools/validator.js'
import { Tool } from '../tools/tool.js'
import { BashTool } from '../tools/bashtool.js'
import { EditTool } from '../tools/edittool.js'

class NoSchemaTool extends Tool {
  get name() { return 'no_schema' }
}

describe('validator', () => {
  it('passes when tool defines no zod schema (e.g. MCP-wrapped tool)', () => {
    const tool = new NoSchemaTool()
    expect(validateInput(tool, { whatever: true }).ok).toBe(true)
    expect(validateOutput(tool, 42).ok).toBe(true)
  })

  it('rejects bash call with missing required field', () => {
    const tool = new BashTool()
    const r = validateInput(tool, {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/command/)
  })

  it('rejects bash call with wrong type', () => {
    const tool = new BashTool()
    const r = validateInput(tool, { command: 123 })
    expect(r.ok).toBe(false)
  })

  it('accepts valid bash input', () => {
    const tool = new BashTool()
    expect(validateInput(tool, { command: 'ls' }).ok).toBe(true)
  })

  it('edit tool requires path/old_string/new_string', () => {
    const tool = new EditTool()
    expect(validateInput(tool, { path: 'a' }).ok).toBe(false)
    expect(validateInput(tool, { path: 'a', old_string: 'x', new_string: 'y' }).ok).toBe(true)
  })

  it('input_schema is derived from zod and has required fields', () => {
    const schema = new BashTool().input_schema
    expect(schema.type).toBe('object')
    expect(schema.required).toContain('command')
  })

  it('output validator catches contract drift', () => {
    class StringOutTool extends Tool {
      get name() { return 'so' }
      get outputSchemaZod() { return z.string() }
    }
    const tool = new StringOutTool()
    expect(validateOutput(tool, 'hi').ok).toBe(true)
    expect(validateOutput(tool, 123).ok).toBe(false)
  })
})
