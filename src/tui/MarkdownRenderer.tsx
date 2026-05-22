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

function CodeBlock({ token, columns }: { token: Tokens.Code; columns: number }) {
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

function ListItemContent({ item, columns }: { item: Tokens.ListItem; columns: number }) {
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
          return <ListContent key={i} token={t as Tokens.List} indent={2} columns={columns} />
        }
        return <Box key={i}>{renderToken(t, i, columns)}</Box>
      })}
    </Box>
  )
}

function ListContent({ token, indent = 0, columns }: { token: Tokens.List; indent?: number; columns: number }) {
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
              <ListItemContent item={item} columns={columns} />
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function BlockquoteContent({ token, columns }: { token: Tokens.Blockquote; columns: number }) {
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
        {token.tokens.map((t, i) => renderToken(t, i, columns))}
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

function renderToken(token: Token, index: number, columns: number): React.ReactNode {
  switch (token.type) {
    case 'heading':    return <HeadingContent key={index} token={token as Tokens.Heading} />
    case 'code':       return <CodeBlock key={index} token={token as Tokens.Code} columns={columns} />
    case 'paragraph':  return <ParagraphContent key={index} token={token as Tokens.Paragraph} />
    case 'list':       return <ListContent key={index} token={token as Tokens.List} columns={columns} />
    case 'blockquote': return <BlockquoteContent key={index} token={token as Tokens.Blockquote} columns={columns} />
    case 'table':      return <TableContent key={index} token={token as Tokens.Table} />
    case 'hr':         return <Text key={index} color="gray">{'─'.repeat(50)}</Text>
    case 'space':      return null
    case 'html':       return null
    default:           return null
  }
}

// ── Main renderer ─────────────────────────────────────────────────────────────

export function MarkdownRenderer({ content }: { content: string }) {
  const { columns } = useWindowSize()
  const elements = useMemo(() => {
    const tokens = lexer(content)
    return tokens.map((token, i) => renderToken(token, i, columns))
  }, [content, columns])
  return (
    <MarkdownErrorBoundary fallback={content}>
      <Box flexDirection="column">{elements}</Box>
    </MarkdownErrorBoundary>
  )
}

// ── Streaming text ────────────────────────────────────────────────────────────
// 直接复用 MarkdownRenderer，得到与最终态完全一致的样式。流式过程中可能出现
// 未闭合的代码围栏，先 sanitize 一下避免 lexer 把整段当代码块吃掉。

function balanceFences(text: string): string {
  const lines = text.split('\n')
  let inFence = false
  let fenceMarker = ''
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (!inFence) {
      if (trimmed.startsWith('```')) { inFence = true; fenceMarker = '```' }
      else if (trimmed.startsWith('~~~')) { inFence = true; fenceMarker = '~~~' }
    } else if (trimmed.startsWith(fenceMarker)) {
      inFence = false
    }
  }
  return inFence ? text + '\n' + fenceMarker : text
}

export function StreamingText({ text, showCursor = false }: { text: string; showCursor?: boolean }) {
  const safe = balanceFences(text)
  return (
    <Box flexDirection="column">
      <MarkdownRenderer content={safe} />
      {showCursor ? <Text color="cyan">▋</Text> : null}
    </Box>
  )
}
