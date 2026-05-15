import Anthropic from '@anthropic-ai/sdk'
import * as readline from 'readline'
import { createClient } from './client'

import { ToolRegistrar } from './tools/toolregistrar'

const toolRegistrar = new ToolRegistrar()
toolRegistrar.registerTool(new (await import('./tools/readtool')).ReadTool())
toolRegistrar.registerTool(new (await import('./tools/writetool')).WriteTool())

const client = createClient()

function executeTool(name: string, input: unknown): string {
  const args = input as Record<string, string>
  try {
    return toolRegistrar.getTool(name)?.execute(args) ?? 'Unknown tool'
  } catch (err) {
    return `Error: ${err}`
  }
}

const MAX_TURNS = 20

async function agentLoop(task: string) {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: task },
  ]

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      tools: toolRegistrar.getAllTools(),
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      for (const block of response.content) {
        if (block.type === 'text') {
          console.log(block.text)
        }
      }
      return
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      console.log(`  [tool] ${block.name}(${JSON.stringify(block.input)})`)
      const result = executeTool(block.name, block.input)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  console.log('[agent] Reached max turns, stopping.')
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve))
}

async function repl() {
  console.log('[myagent] Ready. Type a task (ctrl+c to exit).\n')
  while (true) {
    let input: string
    try {
      input = await question('> ')
    } catch {
      break
    }
    if (!input.trim()) continue
    await agentLoop(input)
    console.log()
  }
  rl.close()
}

repl()
