import Anthropic from '@anthropic-ai/sdk'

export interface RunAgentOptions {
  client: Anthropic
  model: string
  system: string
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  maxTurns?: number
  executeTool: (name: string, input: unknown) => Promise<string>
}

export interface UsageAccum {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export async function runAgentLoop(opts: RunAgentOptions): Promise<Anthropic.MessageParam[]> {
  const { client, model, system, tools, messages, maxTurns = 20, executeTool } = opts

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      tools,
      messages,
      system,
    })
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') break

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const result = await executeTool(block.name, block.input)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return messages
}

export async function runAgentLoopStream(
  opts: RunAgentOptions & {
    onText?: (delta: string) => void
    onTurnEnd?: (text: string) => void
    onToolStart?: (name: string, input: unknown) => void
    onUsage?: (usage: UsageAccum) => void
    signal?: AbortSignal
  },
): Promise<Anthropic.MessageParam[]> {
  const {
    client, model, system, tools, messages, maxTurns = 20,
    executeTool, onText, onTurnEnd, onToolStart, onUsage, signal,
  } = opts

  const cumUsage: UsageAccum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) break

    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      tools,
      messages,
      system,
    })

    signal?.addEventListener('abort', () => stream.abort(), { once: true })

    let turnText = ''
    for await (const event of stream) {
      if (signal?.aborted) break
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        turnText += event.delta.text
        onText?.(event.delta.text)
      }
      // Accumulate usage from message_start (input) and message_delta (output)
      if (event.type === 'message_start') {
        const u = event.message.usage
        cumUsage.inputTokens += u.input_tokens ?? 0
        cumUsage.cacheReadTokens += u.cache_read_input_tokens ?? 0
        cumUsage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0
      }
      if (event.type === 'message_delta') {
        cumUsage.outputTokens += event.usage.output_tokens
      }
    }

    if (turnText) onTurnEnd?.(turnText)
    if (onUsage) onUsage({ ...cumUsage })

    if (signal?.aborted) break

    let response: Anthropic.Message
    try {
      response = await stream.finalMessage()
    } catch {
      break
    }
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') break

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      onToolStart?.(block.name, block.input)
      const result = await executeTool(block.name, block.input)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return messages
}
