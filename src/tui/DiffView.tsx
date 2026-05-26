import React from 'react'
import { Box, Text } from 'ink'
import type { DiffLine } from '../tools/edittool.js'

interface Props {
  filePath: string
  lines: DiffLine[]
  additions: number
  removals: number
}

/**
 * Claude Code style diff:
 *   ⎿  Updated path/to/file.ts with 3 additions and 1 removal
 *        12  -    const old = …
 *        12  +    const fresh = …
 *        13       unchanged
 */
export function DiffView({ filePath, lines, additions, removals }: Props) {
  const summary =
    `${additions} addition${additions === 1 ? '' : 's'}` +
    (removals > 0 ? ` and ${removals} removal${removals === 1 ? '' : 's'}` : '')

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">  ⎿  </Text>
        <Text>Updated </Text>
        <Text bold>{filePath}</Text>
        <Text color="gray"> with {summary}</Text>
      </Box>
      {lines.length > 80 ? (
        <Box paddingLeft={5}>
          <Text color="gray" dimColor>… diff omitted ({lines.length} lines)</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={5}>
          {lines.map((line, i) => {
            const isAdd = line.type === 'add'
            const isRemove = line.type === 'remove'
            const lineNum = isRemove ? (line.oldLine ?? '') : (line.newLine ?? '')
            const sign = isAdd ? '+' : isRemove ? '-' : ' '
            const numStr = String(lineNum).padStart(4)
            return (
              <Box key={i}>
                <Text color="gray" dimColor>{numStr} </Text>
                <Text
                  color={isAdd ? 'green' : isRemove ? 'red' : 'gray'}
                  dimColor={!isAdd && !isRemove}
                >
                  {sign} {line.content}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
