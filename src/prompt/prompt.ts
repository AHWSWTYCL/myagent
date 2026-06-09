import fs from 'fs'
import { fileURLToPath } from 'url'
import * as path from 'path'

/**
 * 构建完整 system prompt。
 * @param agentSection 可选的 sub-agent 描述段落（由 AgentRegistry.describeForPrompt() 生成）
 */
export function getSystemPrompt(agentSection?: string): string {
  const cwd = process.cwd()
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const basePrompt = fs.readFileSync(
    path.join(dir, 'systemprompt.md'),
    'utf-8',
  ).trim()

  const parts: string[] = [basePrompt]

  if (agentSection) {
    parts.push('')
    parts.push(agentSection)
  }

  parts.push('')
  parts.push(`当前工作目录：${cwd}`)

  return parts.join('\n')
}
