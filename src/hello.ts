import { createClient } from './client.js'

async function main() {
  const client = createClient()

  console.log('[myagent] Sending test message to Claude...\n')

  const response = await client.messages.create({
    model: 'deepseek-v4-pro',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content:
          'Reply in one short Chinese sentence: confirm you received this message.',
      },
    ],
  })

  console.log('[myagent] Response:')
  for (const block of response.content) {
    if (block.type === 'text') {
      console.log(block.text)
    }
  }

  console.log('\n[myagent] Usage:')
  console.log(`  input_tokens:  ${response.usage.input_tokens}`)
  console.log(`  output_tokens: ${response.usage.output_tokens}`)
  console.log(`  stop_reason:   ${response.stop_reason}`)
}

main().catch((err) => {
  console.error('[myagent] Error:', err)
  process.exit(1)
})
