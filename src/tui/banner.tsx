import React from 'react'
import { Box, Text } from 'ink'

const COFFEE = '#8B4513'

const home = process.env.HOME ?? ''
const cwd = process.cwd()
const displayPath = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd

const CONTENT = [
  '',
  '       __o    myagent v0.1.0',
  `     _ \\<_    ${displayPath}`,
  '    (_)/(_)',
  '',
]

const W = Math.max(44, ...CONTENT.map(l => l.length + 4))
const pad = (s: string) => s + ' '.repeat(W - s.length)

const top = '┌' + '─'.repeat(W) + '┐'
const bottom = '└' + '─'.repeat(W) + '┘'
const BANNER_ART = [top, ...CONTENT.map(l => `│${pad(l)}│`), bottom].join('\n')

export function Banner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={COFFEE}>{BANNER_ART}</Text>
    </Box>
  )
}
