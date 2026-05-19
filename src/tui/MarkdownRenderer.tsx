import React, { useMemo } from 'react'
import { Box, Text, useWindowSize } from 'ink'
import { lexer } from 'marked'
import type { Tokens, Token } from 'marked'

// ── Helpers ───────────────────────────────────────────────────────────────────

function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  return tokens.map(t => {
    if ('tokens' in t && t.tokens) return plainText(t.tokens as Token[])
    return (t as any).text ?? ''
  }).join('')
}

// ── Error boundary ────────────────────────────────────────────────────────────

interface ErrorBoundaryState { error: Error | null }

class MarkdownErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: string },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return <Text wrap="wrap">{this.props.fallback}</Text>
    }
    return this.props.children
  }
}

// ── Inline token renderer ─────────────────────────────────────────────────────

function InlineContent({ tokens }: { tokens?: Token[] }) {
  if (!tokens?.length) return null
  return (
    <>
      {tokens.map((token, i) => {
        switch (token.type) {
          case 'text':
            return <Text key={i}>{(token as Tokens.Text).text}</Text>
          case 'strong':
            return <Text key={i} bold><InlineContent tokens={(token as Tokens.Strong).tokens} /></Text>
          case 'em':
            return <Text key={i} italic><InlineContent tokens={(token as Tokens.Em).tokens} /></Text>
          case 'codespan':
            return <Text key={i} color="yellow">{(token as Tokens.Codespan).text}</Text>
          case 'link':
            return <Text key={i} color="blueBright" underline>{(token as Tokens.Link).text}</Text>
          case 'del':
            return <Text key={i} strikethrough><InlineContent tokens={(token as Tokens.Del).tokens} /></Text>
          case 'br':
            return <Text key={i}>{'\n'}</Text>
          case 'image':
            return <Text key={i} dimColor>{'[image: ' + (token as Tokens.Image).text + ']'}</Text>
          case 'escape':
            return <Text key={i}>{(token as any).text}</Text>
          default:
            return <Text key={i}>{(token as any).text ?? ''}</Text>
        }
      })}
    </>
  )
}

// ── Block renderers ───────────────────────────────────────────────────────────

function HeadingContent({ token }: { token: Tokens.Heading }) {
  const colors: Record<number, string> = { 1: 'cyanBright', 2: 'cyan', 3: 'blue', 4: 'blue' }
  const color = colors[token.depth] ?? 'white'
  const prefix = token.depth <= 2 ? '#'.repeat(token.depth) + ' ' : ''
  return (
    <Box marginY={1}>
      <Text bold color={color as any}>{prefix}<InlineContent tokens={token.tokens} /></Text>
    </Box>
  )
}

function CodeBlock({ token }: { token: Tokens.Code }) {
  const { columns } = useWindowSize()
  const lang = token.lang ? ' ' + token.lang + ' ' : ''
  const innerWidth = Math.max(20, columns - 12)
  const topRule = '┌─' + lang + '─'.repeat(Math.max(0, innerWidth - lang.length - 2))
  const botRule = '└' + '─'.repeat(innerWidth)
  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="gray">{topRule}</Text>
      <Box flexDirection="column" paddingX={2}>
        {token.text.split('\n').map((line, i) => (
          <Text key={i} color="yellow">{line || ' '}</Text>
        ))}
      </Box>
      <Text color="gray">{botRule}</Text>
    </Box>
  )
}

function ParagraphContent({ token }: { token: Tokens.Paragraph }) {
  return (
    <Box marginBottom={1}>
      <Text wrap="wrap"><InlineContent tokens={token.tokens} /></Text>
    </Box>
  )
}

function ListItemContent({ item }: { item: Tokens.ListItem }) {
  return (
    <Box flexDirection="column">
      {item.tokens.map((t, i) => {
        if (t.type === 'text') {
          return (
            <Text key={i} wrap="wrap">
              <InlineContent tokens={(t as Tokens.Text).tokens} />
            </Text>
          )
        }
        if (t.type === 'list') {
          return <ListContent key={i} token={t as Tokens.List} indent={2} />
        }
        return <Box key={i}>{renderToken(t, i)}</Box>
      })}
    </Box>
  )
}

function ListContent({ token, indent = 0 }: { token: Tokens.List; indent?: number }) {
  return (
    <Box flexDirection="column" marginLeft={indent} marginBottom={indent === 0 ? 1 : 0}>
      {token.items.map((item, i) => {
        let bullet: string
        if (item.task) {
          bullet = item.checked ? '[x] ' : '[ ] '
        } else {
          bullet = token.ordered ? `${i + 1}. ` : '• '
        }
        return (
          <Box key={i}>
            <Text color="gray">{bullet}</Text>
            <Box flexDirection="column" flexGrow={1}>
              <ListItemContent item={item} />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function BlockquoteContent({ token }: { token: Tokens.Blockquote }) {
  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeft={true}
      borderColor="gray"
      paddingLeft={1}
      marginY={1}
    >
      <Box flexDirection="column">
        {token.tokens.map((t, i) => renderToken(t, i))}
      </Box>
    </Box>
  )
}

function TableContent({ token }: { token: Tokens.Table }) {
  const colWidths = token.header.map((h, ci) => {
    const headerLen = plainText(h.tokens as Token[]).length
    const maxRowLen = Math.max(0, ...token.rows.map(row =>
      plainText((row[ci]?.tokens ?? []) as Token[]).length
    ))
    return Math.max(headerLen, maxRowLen, 3)
  })

  function padCell(text: string, width: number, align: string | null) {
    if (align === 'right') return text.padStart(width)
    if (align === 'center') {
      const pad = width - text.length
      return ' '.repeat(Math.floor(pad / 2)) + text + ' '.repeat(Math.ceil(pad / 2))
    }
    return text.padEnd(width)
  }

  const headerCells = token.header.map((h, i) =>
    padCell(plainText(h.tokens as Token[]), colWidths[i], token.align[i])
  )
  const separator = colWidths.map((w, i) => {
    const line = '─'.repeat(w)
    if (token.align[i] === 'center') return ':' + line.slice(1, -1) + ':'
    if (token.align[i] === 'right') return line.slice(0, -1) + ':'
    return line
  })

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>{'│ ' + headerCells.join(' │ ') + ' │'}</Text>
      <Text color="gray">{'├─' + separator.join('─┼─') + '─┤'}</Text>
      {token.rows.map((row, ri) => {
        const cells = row.map((cell, ci) =>
          padCell(plainText((cell.tokens ?? []) as Token[]), colWidths[ci], token.align[ci])
        )
        return <Text key={ri}>{'│ ' + cells.join(' │ ') + ' │'}</Text>
      })}
      <Text color="gray">{'└─' + colWidths.map(w => '─'.repeat(w)).join('─┴─') + '─┘'}</Text>
    </Box>
  )
}

// ── Token dispatcher ──────────────────────────────────────────────────────────

function renderToken(token: Token, index: number): React.ReactNode {
  switch (token.type) {
    case 'heading':    return <HeadingContent key={index} token={token as Tokens.Heading} />
    case 'code':       return <CodeBlock key={index} token={token as Tokens.Code} />
    case 'paragraph':  return <ParagraphContent key={index} token={token as Tokens.Paragraph} />
    case 'list':       return <ListContent key={index} token={token as Tokens.List} />
    case 'blockquote': return <BlockquoteContent key={index} token={token as Tokens.Blockquote} />
    case 'table':      return <TableContent key={index} token={token as Tokens.Table} />
    case 'hr':         return <Text key={index} color="gray">{'─'.repeat(50)}</Text>
    case 'space':      return null
    case 'html':       return null
    default:           return null
  }
}

// ── Main renderer ─────────────────────────────────────────────────────────────

export function MarkdownRenderer({ content }: { content: string }) {
  const elements = useMemo(() => {
    const tokens = lexer(content)
    return tokens.map((token, i) => renderToken(token, i))
  }, [content])
  return (
    <MarkdownErrorBoundary fallback={content}>
      <Box flexDirection="column">{elements}</Box>
    </MarkdownErrorBoundary>
  )
}

// ── Streaming text ────────────────────────────────────────────────────────────

export function StreamingText({ text, showCursor = false }: { text: string; showCursor?: boolean }) {
  const lines = text.split('\n')

  const { rendered } = lines.reduce<{ rendered: React.ReactNode[]; inCode: boolean }>(
    ({ rendered, inCode }, line, i) => {
      const isLast = i === lines.length - 1
      const cursor = isLast && showCursor ? '▋' : ''
      const trimmed = line.trimStart()
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        return {
          rendered: [...rendered, <Text key={i} color="gray" dimColor>{line}{cursor}</Text>],
          inCode: !inCode,
        }
      }
      if (inCode) {
        return {
          rendered: [...rendered, <Text key={i} color="yellow">{(line || ' ') + cursor}</Text>],
          inCode,
        }
      }
      const parts = line.split(/(`[^`]+`)/)
      return {
        rendered: [
          ...rendered,
          <Text key={i} wrap="wrap">
            {parts.map((part, j) =>
              part.startsWith('`') && part.endsWith('`') && part.length > 2
                ? <Text key={j} color="yellow">{part}</Text>
                : <React.Fragment key={j}>{part || ' '}</React.Fragment>
            )}
            {cursor}
          </Text>,
        ],
        inCode,
      }
    },
    { rendered: [], inCode: false },
  )

  return <Box flexDirection="column">{rendered}</Box>
}
