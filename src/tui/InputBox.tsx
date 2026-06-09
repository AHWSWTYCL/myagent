import React from 'react'
import { Box, Text } from 'ink'
import { MultilineTextInput } from './MultilineTextInput.js'
import type { Suggestion } from '../commands/commandregistry.js'
import type { FileAttachment } from '../utils/attachments.js'
import type { SubAgentTask } from './bridge.js'
import { buildSubAgentLine } from './SubAgentTaskPanel.js'

interface InputBoxProps {
  inputValue: string
  onChange: (v: string) => void
  onSubmit: (v: string) => void
  isProcessing: boolean
  isQuestion: boolean
  questionPrompt: string
  attachments: FileAttachment[]
  attachmentErrors: string[]
  suggestions: Suggestion[]
  selectedSuggestionIndex: number
}

/**
 * Claude Code style chat input:
 *
 * ╭───────────────────────────────────────────╮
 * │ > your prompt here                        │
 * ╰───────────────────────────────────────────╯
 *
 * Border tints reflect mode: cyan default, green for !, gray when busy,
 * yellow during permission/question.
 */
export function InputBox(props: InputBoxProps) {
  const {
    inputValue, onChange, onSubmit,
    isProcessing, isQuestion, questionPrompt,
    attachments, attachmentErrors,
    suggestions, selectedSuggestionIndex,
  } = props

  const isBash = inputValue.startsWith('!')
  const isCmd = inputValue.startsWith('/')
  const borderColor = isQuestion
    ? 'yellow'
    : isProcessing
      ? 'gray'
      : isBash
        ? 'green'
        : isCmd
          ? 'magenta'
          : 'cyan'

  // Glyph in front of the input — Claude Code uses ">" for input, "$" hint for bash.
  let promptGlyph: React.ReactNode
  let promptColor: string
  if (isQuestion) {
    promptGlyph = questionPrompt + ' '
    promptColor = 'yellow'
  } else if (isBash) {
    promptGlyph = '! '
    promptColor = 'green'
  } else if (isCmd) {
    promptGlyph = '/ '
    promptColor = 'magenta'
  } else {
    promptGlyph = '> '
    promptColor = 'cyan'
  }

  return (
    <Box flexDirection="column">
      {/* Attachments preview — sits above the box, like Claude Code. */}
      {(attachments.length > 0 || attachmentErrors.length > 0) ? (
        <Box flexDirection="column" marginBottom={0} paddingX={1}>
          {attachments.map((att, i) => (
            <Box key={i}>
              <Text color="cyan">⎘ </Text>
              <Text bold>{att.name}</Text>
              <Text color="gray" dimColor>{`  (${att.kind})`}</Text>
            </Box>
          ))}
          {attachmentErrors.map((err, i) => (
            <Box key={`err-${i}`}>
              <Text color="yellow">! </Text>
              <Text color="yellow" dimColor>{err}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      <Box
        borderStyle="round"
        borderColor={borderColor as any}
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Text color={promptColor as any} bold>{promptGlyph}</Text>
          <MultilineTextInput
            value={inputValue}
            onChange={onChange}
            onSubmit={onSubmit}
            focus={!isQuestion && isProcessing ? true : !isProcessing || isQuestion}
            placeholder={isProcessing ? 'esc to interrupt…' : ''}
          />
        </Box>
      </Box>

      {suggestions.length > 0 ? (
        <Box flexDirection="column" marginTop={0} marginLeft={2}>
          {suggestions.map((s, i) => {
            const isSelected = i === selectedSuggestionIndex
            return (
              <Box key={s.name} flexDirection="column">
                <Box>
                  <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '❯ ' : '  '}</Text>
                  <Text color={isSelected ? 'cyan' : 'white'} bold={isSelected}>/{s.name}</Text>
                  <Text color="gray" dimColor>{'  '}{s.description}</Text>
                </Box>
                {isSelected && s.usage ? (
                  <Box paddingLeft={4}>
                    <Text color="gray" dimColor>usage: {s.usage}</Text>
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}

interface FooterProps {
  isProcessing: boolean
  hasSuggestions: boolean
  autoMode: boolean
  expanded: boolean
  ctxPercent: number | null
  ctxText: string | null
  transientHint: string
  modelName?: string
  subAgentTasks?: SubAgentTask[]
  backgroundCount?: number
  goalText?: string
}

const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)

export function buildCtx(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null, max: number) {
  if (!usage) return { pct: null as number | null, text: null as string | null }
  const total = usage.inputTokens + usage.cacheReadTokens
  const pct = Math.min(100, Math.round((total / max) * 100))
  const text = `${pct}% · ${fmt(total)}/${fmt(max)}`
  return { pct, text }
}

/**
 * Bottom-of-screen status line. One row, dim, mirrors Claude Code:
 *   ? for shortcuts · auto · model · ctx 23% (40k/200k)
 */
export function Footer({
  isProcessing,
  hasSuggestions,
  autoMode,
  expanded,
  ctxPercent,
  ctxText,
  transientHint,
  modelName,
  subAgentTasks,
  backgroundCount = 0,
  goalText,
}: FooterProps) {
  const left = hasSuggestions
    ? '↑↓ navigate · tab/→ accept · esc close · enter run'
    : isProcessing
      ? 'esc interrupt · ctrl+e stop tts · ctrl+b background · / commands · @ files'
      : `? for shortcuts · / cmd · @ file · ! shell · shift+tab auto · \\ then enter newline · ctrl+o ${expanded ? 'collapse' : 'expand'} · ctrl+l logs`

  // Only show sub-agent summary in Footer when >=2 parallel agents.
  // With a single agent, the tool card header (e.g. "⏺ Task(explore)") is sufficient.
  const subAgentLine = subAgentTasks && subAgentTasks.length >= 2
    ? buildSubAgentLine(subAgentTasks)
    : null

  return (
    <Box flexDirection="column" marginTop={0}>
      {transientHint ? (
        <Box paddingX={1}>
          <Text color="yellow" dimColor>{transientHint}</Text>
        </Box>
      ) : null}
      {/* Compact sub-agent status line — Claude Code style, sits between hint and footer row */}
      {subAgentLine ? (
        <Box paddingX={1}>
          <Text bold color="gray">{subAgentLine}</Text>
        </Box>
      ) : null}
      <Box justifyContent="space-between" paddingX={1}>
        <Text color="gray" dimColor>{left}</Text>
        <Box>
          {goalText ? (
            <>
              <Text color="yellow">{goalText}</Text>
              <Text color="gray" dimColor>  ·  </Text>
            </>
          ) : null}
          {backgroundCount > 0 ? (
            <>
              <Text color="yellow" bold>{`[bg:${backgroundCount}]`}</Text>
              <Text color="gray" dimColor>  ·  </Text>
            </>
          ) : null}
          {autoMode ? (
            <>
              <Text color="green" bold>AUTO</Text>
              <Text color="gray" dimColor>  ·  </Text>
            </>
          ) : null}
          {expanded ? (
            <>
              <Text color="cyan" bold>EXPAND</Text>
              <Text color="gray" dimColor>  ·  </Text>
            </>
          ) : null}
          {modelName ? (
            <>
              <Text color="gray" dimColor>{modelName}</Text>
              <Text color="gray" dimColor>{ctxText ? '  ·  ' : ''}</Text>
            </>
          ) : null}
          {ctxText ? (
            <Text color={ctxPercent !== null && ctxPercent >= 80 ? 'yellow' : 'gray'} dimColor={ctxPercent === null || ctxPercent < 80}>
              ctx {ctxText}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}
