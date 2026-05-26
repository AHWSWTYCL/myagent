import React from 'react'
import { Box, Text } from 'ink'
import type { ChoiceQuestion } from './types.js'

const PERMISSION_LABELS = [
  'Yes',
  'Yes, allow for the rest of session',
  'No (esc)',
] as const

interface PermissionProps {
  prompt: string
  selected: 0 | 1 | 2
}

/**
 * Claude Code style permission box:
 *
 * ╭─ Tool use ────────────────────╮
 * │ {prompt body}                 │
 * │                               │
 * │ Do you want to proceed?       │
 * │   ❯ 1. Yes                    │
 * │     2. Yes, for session       │
 * │     3. No (esc)               │
 * ╰───────────────────────────────╯
 */
export function PermissionPrompt({ prompt, selected }: PermissionProps) {
  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color="yellow" bold>Tool use</Text>
      </Box>
      <Box marginTop={1}>
        <Text wrap="wrap">{prompt}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Do you want to proceed?</Text>
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {PERMISSION_LABELS.map((label, i) => {
          const sel = i === selected
          return (
            <Box key={i}>
              <Text color={sel ? 'cyan' : 'gray'}>{sel ? ' ❯ ' : '   '}</Text>
              <Text color={sel ? 'cyan' : 'white'} bold={sel}>{i + 1}. {label}</Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

interface ChoiceProps {
  questions: ChoiceQuestion[]
  selections: number[]
  focus: number
  customActive: number | null
  customInput: string
  customValues: Record<number, string>
}

/**
 * Claude Code style multi-question choice box.
 * Focused row gets a cyan border tint and ❯ marker.
 */
export function ChoicePrompt({
  questions,
  selections,
  focus,
  customActive,
  customInput,
  customValues,
}: ChoiceProps) {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
    >
      <Box>
        <Text color="cyan" bold>Please answer</Text>
        <Text color="gray" dimColor>{'  ↑↓ row · ←→ option · enter confirm · esc cancel'}</Text>
      </Box>

      {questions.map((q, qi) => {
        const focused = focus === qi
        const selectedIdx = selections[qi] ?? 0
        const opts = q.allowOther
          ? [...q.options, { value: '__other__', label: 'Other (type custom value)' }]
          : q.options
        const isOther = q.allowOther && selectedIdx === q.options.length
        const customDisplay = customValues[qi]

        return (
          <Box key={q.id} flexDirection="column" marginTop={1}>
            <Box>
              <Text color={focused ? 'cyan' : 'gray'}>{focused ? ' ❯ ' : '   '}</Text>
              <Text color={focused ? 'cyan' : 'white'} bold={focused}>{qi + 1}. {q.prompt}</Text>
            </Box>
            <Box marginLeft={5} flexDirection="column">
              {opts.map((opt, oi) => {
                const isSel = oi === selectedIdx
                const color = isSel ? (focused ? 'cyan' : 'green') : 'gray'
                return (
                  <Box key={opt.value}>
                    <Text color={color} bold={isSel}>{isSel ? '◉ ' : '○ '}{opt.label}</Text>
                  </Box>
                )
              })}
              {isOther && customDisplay !== undefined && customActive !== qi ? (
                <Box>
                  <Text color="gray" dimColor>     ↳ </Text>
                  <Text color="green">{customDisplay || '(empty)'}</Text>
                </Box>
              ) : null}
              {customActive === qi ? (
                <Box>
                  <Text color="cyan">▎</Text>
                  <Text>{customInput}</Text>
                  <Text color="cyan">▌</Text>
                  <Text color="gray" dimColor>{'  enter confirm · esc cancel'}</Text>
                </Box>
              ) : null}
            </Box>
          </Box>
        )
      })}

      <Box marginTop={1}>
        {(['Submit', 'Cancel'] as const).map((label, bi) => {
          const idx = questions.length + bi
          const focused = focus === idx
          const color = focused ? (label === 'Submit' ? 'green' : 'red') : 'gray'
          return (
            <Box key={label} marginRight={2}>
              <Text color={color} bold={focused}>{focused ? '❯ ' : '  '}[{label}]</Text>
            </Box>
          )
        })}
        <Text color="gray" dimColor>{`  (focus ${focus < questions.length ? `Q${focus + 1}` : focus === questions.length ? 'Submit' : 'Cancel'})`}</Text>
      </Box>
    </Box>
  )
}
