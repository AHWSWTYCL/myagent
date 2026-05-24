import fs from 'fs'
import path from 'path'
import { AgentDefinition, AgentInputSchema } from './definition.js'

interface MarkdownAgentFrontmatter {
  name?: string
  description?: string
  tools?: string[]
  model?: string
  maxTurns?: number
  inputSchema?: AgentInputSchema
}

/**
 * 极简 frontmatter 解析。期望格式：
 *
 *   ---
 *   name: explore
 *   description: ...
 *   tools: [read_file, list_dir, bash]
 *   model: claude-sonnet-4-6
 *   maxTurns: 10
 *   ---
 *   <system prompt 正文>
 *
 * 不支持嵌套对象，复杂场景下用代码定义。
 */
function parseFrontmatter(raw: string): { meta: MarkdownAgentFrontmatter; body: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { meta: {}, body: raw }
  }
  const closing = raw.indexOf('\n---', 4)
  if (closing < 0) return { meta: {}, body: raw }

  const headerBlock = raw.slice(4, closing).trim()
  const body = raw.slice(closing + 4).replace(/^\r?\n/, '')

  const meta: MarkdownAgentFrontmatter = {}
  for (const line of headerBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1] as keyof MarkdownAgentFrontmatter
    const value = m[2].trim()
    if (key === 'tools') {
      const inside = value.replace(/^\[|\]$/g, '')
      ;(meta as Record<string, unknown>)[key] = inside.split(',').map(s => s.trim()).filter(Boolean)
    } else if (key === 'maxTurns') {
      ;(meta as Record<string, unknown>)[key] = Number(value)
    } else {
      ;(meta as Record<string, unknown>)[key] = value
    }
  }
  return { meta, body: body.trimEnd() }
}

export function loadAgentFromMarkdown(filePath: string): AgentDefinition {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const { meta, body } = parseFrontmatter(raw)

  const fallbackName = path.basename(filePath, path.extname(filePath))
  const name = meta.name?.trim() || fallbackName
  if (!meta.description) {
    throw new Error(`Agent markdown ${filePath} missing 'description' frontmatter`)
  }

  return {
    name,
    description: meta.description,
    systemPrompt: body,
    tools: meta.tools ?? [],
    model: meta.model,
    maxTurns: meta.maxTurns,
    inputSchema: meta.inputSchema,
  }
}

/** 扫描目录加载所有 *.md，找不到目录返回空数组 */
export function loadAgentsFromDir(dir: string): AgentDefinition[] {
  if (!fs.existsSync(dir)) return []
  const out: AgentDefinition[] = []
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue
    const full = path.join(dir, entry)
    try {
      out.push(loadAgentFromMarkdown(full))
    } catch (err) {
      console.error(`[agents] failed to load ${full}:`, err)
    }
  }
  return out
}
