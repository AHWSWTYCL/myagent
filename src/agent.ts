import Anthropic from '@anthropic-ai/sdk'
import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import { createClient } from './client'

import { getSystemPrompt } from './prompt/prompt'
import { getMemoryPrompt, getUserMessage, MEMORY_FILE_PATH } from './memory/memory'

import { ToolRegistrar } from './tools/toolregistrar'

const toolRegistrar = new ToolRegistrar()
toolRegistrar.registerTool(new (await import('./tools/readtool')).ReadTool())
toolRegistrar.registerTool(new (await import('./tools/writetool')).WriteTool())
toolRegistrar.registerTool(new (await import('./tools/listdirtool')).ListDirTool())
toolRegistrar.registerTool(new (await import('./tools/bashtool')).BashTool())

const client = createClient()

const baseSystemPrompt = getSystemPrompt()
console.log('[agent] System prompt loaded\n' + baseSystemPrompt)


async function checkPermission(toolName: string): Promise<boolean> {
  if (toolName === 'write_file' || toolName === 'bash') {
    const label = toolName === 'bash' ? 'run a bash command' : 'write a file'
    let answer = await question(`The agent wants to ${label}. Do you allow this? (yes/no) `)
    answer = answer.trim().toLowerCase()
    return answer === 'yes' || answer === 'y'
  }
  return true
}

async function executeTool(name: string, input: unknown, skipPermissionCheck: boolean = false): Promise<string> {
  const args = input as Record<string, string>
  try {
    if (!skipPermissionCheck && !await checkPermission(name)) {
      return 'Permission denied'
    }
    return toolRegistrar.getTool(name)?.execute(args) ?? 'Unknown tool'
  } catch (err) {
    return `Error: ${err}`
  }
}

const MAX_TURNS = 20
const MEMORY_CONSOLIDATE_THRESHOLD = 10

// 流式事件类型
type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; message: Anthropic.Message }

/**
 * 异步生成器：调用 SDK stream，逐字 yield 文本 delta，最后 yield 完整 message。
 * 调用方可以边收 text 事件边打印，收到 done 事件后拿完整 message 继续逻辑。
 */
async function* streamResponse(
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
): AsyncGenerator<StreamEvent> {
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    tools: toolRegistrar.getAllTools(),
    messages,
    system: systemPrompt,
  })

  // 逐个 text delta yield 出去，调用方实时打印
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield { type: 'text', text: event.delta.text }
    }
  }

  // 流结束后，yield 完整 message（包含 stop_reason、tool_use 等）
  const finalMessage = await stream.finalMessage()
  yield { type: 'done', message: finalMessage }
}

// 返回 true 表示 memory.md 被成功写入，false 表示整理失败
async function consolidateMemory(conversationHistory: Anthropic.MessageParam[]): Promise<boolean> {
  console.log('[agent] Memory 整理...')
  const contentBefore = fs.existsSync(MEMORY_FILE_PATH) ? fs.readFileSync(MEMORY_FILE_PATH, 'utf-8') : ''

  const historyText = conversationHistory
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `以下是最近的对话记录，请整理：\n\n${historyText}` },
  ]
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      tools: toolRegistrar.getAllTools(),
      messages,
      system: getMemoryPrompt(),
    })
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') break

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const result = await executeTool(block.name, block.input, true)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  const contentAfter = fs.existsSync(MEMORY_FILE_PATH) ? fs.readFileSync(MEMORY_FILE_PATH, 'utf-8') : ''
  if (contentAfter === contentBefore) {
    console.log('[agent] Memory 整理失败：memory.md 未被写入，保留当前上下文')
    return false
  }
  console.log('[agent] Memory 整理完毕')
  return true
}

async function extractMemory(): Promise<string> {
  console.log('[agent] 提取记忆...')
  const userMessage = getUserMessage()
  if (!userMessage) {
    console.log('[agent] 没有用户记忆')
    return ''
  }
  console.log(userMessage.trim())
  console.log('[agent] 用户记忆提取完毕')
  return userMessage
}

function buildSystemPromptWithMemory(memory: string): string {
  if (!memory) return baseSystemPrompt
  return `${baseSystemPrompt}\n\n## 历史记忆\n${memory}`
}

async function agentLoop(context: { messages: Anthropic.MessageParam[]; systemPrompt: string }): Promise<Anthropic.MessageParam[] | null> {
  const { messages, systemPrompt } = { ...context }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // 消费生成器：收到 text 就实时打印，收到 done 就拿完整 message
    let response: Anthropic.Message | null = null
    for await (const event of streamResponse(messages, systemPrompt)) {
      if (event.type === 'text') {
        process.stdout.write(event.text)
      } else {
        response = event.message
      }
    }

    if (!response) break
    // text 流结束后补一个换行
    process.stdout.write('\n')

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      return messages
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      console.log(`  [tool] ${block.name}(${JSON.stringify(block.input)})`)
      const result = await executeTool(block.name, block.input)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  console.log('[agent] Reached max turns, stopping.')
  return messages
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

  const memory = await extractMemory()
  let context: { messages: Anthropic.MessageParam[]; systemPrompt: string } = {
    messages: [],
    systemPrompt: buildSystemPromptWithMemory(memory),
  }

  while (true) {
    let input: string
    try {
      input = await question('> ')
    } catch {
      break
    }
    if (!input.trim()) continue
    context.messages.push({ role: 'user', content: input })

    let history: Anthropic.MessageParam[] | null = null
    try {
      history = await agentLoop(context)
    } catch (err) {
      console.error(`[agent] Error: ${err}`)
      // 回滚刚加入的 user 消息，避免下一轮发送残缺的对话历史
      context.messages.pop()
      continue
    }

    // 当 messages 积累超过阈值时触发记忆整理
    // 用 messages.length 而不是 turnCount，避免 tool use 产生的额外消息导致计数对不上
    if (history && history.length >= MEMORY_CONSOLIDATE_THRESHOLD) {
      const consolidated = await consolidateMemory(history)
      if (consolidated) {
        const newMemory = await extractMemory()
        context = {
          messages: [],
          systemPrompt: buildSystemPromptWithMemory(newMemory),
        }
      }
    }
  }
  rl.close()
}

repl()
