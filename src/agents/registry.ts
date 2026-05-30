import { AgentDefinition } from './definition.js'
import { attachmentQueue } from '../attachment/queue.js'
import { AgentAttachment } from '../attachment/agent.js'

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>()

  register(def: AgentDefinition): void {
    if (this.agents.has(def.name)) {
      console.error(`[agents] duplicate agent name "${def.name}", overwriting`)
    }
    this.agents.set(def.name, def)
    attachmentQueue.enqueue(new AgentAttachment(def.name, def.description))
  }

  registerAll(defs: AgentDefinition[]): void {
    for (const d of defs) this.register(d)
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name)
  }

  list(): AgentDefinition[] {
    return Array.from(this.agents.values())
  }

  /** 拼一段 prompt 段落，列出所有 agent 的能力 */
  describeForPrompt(): string {
    const items = this.list()
    if (items.length === 0) return ''
    const lines = ['## 可用 sub-agent', '']
    lines.push('使用 `agent` 工具调用以下任意 sub-agent，传入 agent 名 + task。')
    lines.push('')
    for (const a of items) {
      lines.push(`### ${a.name}`)
      lines.push(a.description.trim())
      if (a.tools.length > 0) {
        lines.push(`允许使用的工具: ${a.tools.join(', ')}`)
      }
      lines.push('')
    }
    return lines.join('\n').trimEnd()
  }
}
