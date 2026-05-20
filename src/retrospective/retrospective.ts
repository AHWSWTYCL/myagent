import * as fs from 'fs'
import * as path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { runAgentLoop } from '../utils/runagent.js'
import { SkillManager } from '../skills/skillmanager.js'
import { MemoryTool } from '../tools/memorytool.js'
import { SkillWriteTool } from '../tools/skillwritetool.js'

const RETROSPECTIVE_MODEL = 'claude-haiku-4-5'
const MAX_HISTORY_MESSAGES = 60  // 只取最近 60 条，避免 token 过多
const MAX_TURNS = 10

function getRetrospectivePrompt(): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'prompt.md'), 'utf-8').trim()
}

function formatHistory(messages: Anthropic.MessageParam[]): string {
  return messages
    .map(m => {
      const role = m.role === 'user' ? '用户' : 'Agent'
      const content = typeof m.content === 'string'
        ? m.content
        : m.content
            .filter(b => b.type === 'text')
            .map(b => (b as Anthropic.TextBlock).text)
            .join(' ')
      return `${role}: ${content}`
    })
    .filter(line => line.length > 10)
    .join('\n')
}

export async function runRetrospective(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  skillManager: SkillManager,
  onStatus: (msg: string) => void,
): Promise<void> {
  onStatus('复盘中...')

  const recentMessages = messages.slice(-MAX_HISTORY_MESSAGES)
  const historyText = formatHistory(recentMessages)

  if (!historyText.trim()) {
    onStatus('复盘完成（无有效对话历史）')
    return
  }

  // 复盘 agent 专用工具集（隔离，不暴露 bash/read/write 等）
  const memoryTool = new MemoryTool()
  const skillWriteTool = new SkillWriteTool(skillManager)

  const tools: Anthropic.Tool[] = [
    { name: memoryTool.name, description: memoryTool.description, input_schema: memoryTool.input_schema },
    { name: skillWriteTool.name, description: skillWriteTool.description, input_schema: skillWriteTool.input_schema },
  ]

  async function executeTool(name: string, input: unknown): Promise<string> {
    const args = input as Record<string, string>
    try {
      if (name === memoryTool.name) return await memoryTool.execute(args as any)
      if (name === skillWriteTool.name) return await skillWriteTool.execute(args as any)
      return `未知工具：${name}`
    } catch (err) {
      return `Error: ${err}`
    }
  }

  await runAgentLoop({
    client,
    model: RETROSPECTIVE_MODEL,
    system: getRetrospectivePrompt(),
    tools,
    messages: [
      {
        role: 'user',
        content: `以下是最近的对话记录，请进行复盘分析：\n\n${historyText}`,
      },
    ],
    maxTurns: MAX_TURNS,
    executeTool,
  })

  onStatus('复盘完成')
}
