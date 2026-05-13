import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import * as readline from 'readline'
import { createClient } from './client.js'

const client = createClient()

const tools: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the filesystem and return its contents',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating it if it does not exist',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
]

function executeTool(name: string, input: unknown): string {
  const args = input as Record<string, string>
  try {
    if (name === 'read_file') {
      return fs.readFileSync(args.path, 'utf-8')
    }
    if (name === 'write_file') {
      fs.writeFileSync(args.path, args.content)
      return `OK — wrote ${args.content.length} bytes to ${args.path}`
    }
    return `Unknown tool: ${name}`
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
      tools,
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
