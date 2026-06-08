import React from 'react'
import { Box, Text } from 'ink'
import { modelConfig } from '../llm/model-config.js'
import { advisorConfig } from '../llm/advisor-config.js'

const COFFEE = '#8B4513'

const home = process.env.HOME ?? ''
const cwd = process.cwd()
const displayPath = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd

const currentModel = modelConfig.getCurrent()
const modelInfo = modelConfig.find(currentModel)

const advisorModel = advisorConfig.getCurrent()
const advisorInfo = advisorConfig.find(advisorModel)
const advisorLine = advisorConfig.available
  ? `advisor: ${advisorInfo?.displayName ?? advisorModel}`
  : 'advisor: (unavailable — no Claude API key)'

const CONTENT = [
  '',
  '       __o    myagent v0.1.0',
  `     _ \\<_    ${displayPath}`,
  `    (_)/(_)   model: ${modelInfo?.displayName ?? currentModel}`,
  `              ${advisorLine}`,
  '',
]

const W = Math.max(44, ...CONTENT.map(l => l.length + 4))
const pad = (s: string) => s + ' '.repeat(W - s.length)

const top = '┌' + '─'.repeat(W) + '┐'
const bottom = '└' + '─'.repeat(W) + '┘'
const BANNER_LINES: readonly string[] = [top, ...CONTENT.map(l => `│${pad(l)}│`), bottom]

export const Banner = React.memo(function Banner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {BANNER_LINES.map((line, i) => (
        <Text key={i} color={COFFEE}>{line}</Text>
      ))}
    </Box>
  )
})
