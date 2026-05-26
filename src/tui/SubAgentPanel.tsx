import React from 'react'
import { Box, Text } from 'ink'
import { Spinner } from './Spinner.js'

interface Props {
  name: string
  text: string
  heartbeat?: { elapsedMs: number; lastBeatAt: number }
  elapsedSec: number
}

/**
 * Sub-agent live output panel — Claude Code "Task" agent style:
 *   ⏺ {agent_name}(running 12s)
 *     ⎿  recent line 1
 *        recent line 2
 *        ✻ Cogitating… (8s · esc to interrupt)
 */
export function SubAgentPanel({ name, text, heartbeat, elapsedSec }: Props) {
  const lines = (text ?? '').split('\n')
  const tail = lines.length > 12 ? lines.slice(-12) : lines
  const omitted = lines.length > 12 ? lines.length - 12 : 0

  return (
    <Box flexDirection="column" marginTop={0} marginBottom={1}>
      <Box>
        <Text color="magenta">⏺ </Text>
        <Text bold color="magenta">{name}</Text>
        <Text color="gray" dimColor>{` (running ${elapsedSec}s)`}</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        <Box>
          <Text color="gray">⎿  </Text>
          <Box flexDirection="column">
            {omitted > 0 ? (
              <Text color="gray" dimColor>… {omitted} earlier line{omitted === 1 ? '' : 's'} omitted</Text>
            ) : null}
            {tail.map((line, i) => (
              <Text key={i} color="gray" wrap="wrap">{line}</Text>
            ))}
            {heartbeat ? (
              <Spinner
                active
                elapsedSec={Math.floor(heartbeat.elapsedMs / 1000)}
                color="magenta"
                showInterruptHint={false}
              />
            ) : null}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
