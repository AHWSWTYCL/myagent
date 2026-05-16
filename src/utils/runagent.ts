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
  opts: RunAgentOptions & { onText?: (delta: string) => void },
): Promise<Anthropic.MessageParam[]> {
  const { client, model, system, tools, messages, maxTurns = 20, executeTool, onText } = opts

  for (let turn = 0; turn < maxTurns; turn++) {
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      tools,
      messages,
      system,
    })

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        onText
      ) {
        onText(event.delta.text)
      }
    }

    const response = await stream.finalMessage()
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
