import React from 'react'
import { Box, Text } from 'ink'
import type { MCPServerInfo } from '../mcp/mcpmanager.js'

interface Props {
  serverInfos: MCPServerInfo[]
}

function statusColor(status: string): string {
  switch (status) {
    case 'connected':    return 'green'
    case 'connecting':   return 'yellow'
    case 'error':        return 'red'
    case 'disconnected': return 'gray'
    default:             return 'gray'
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'connected':    return '●'
    case 'connecting':   return '◐'
    case 'error':        return '✗'
    case 'disconnected': return '○'
    default:             return '?'
  }
}

export function McpStatusPanel({ serverInfos }: Props) {
  if (serverInfos.length === 0) return null

  return (
    <Box flexDirection="column" paddingX={1} marginTop={0}>
      <Text color="cyan" bold>MCP</Text>
      {serverInfos.map(info => (
        <Box key={info.name} marginLeft={1}>
          <Text color={statusColor(info.status) as any}>
            {statusIcon(info.status)}
          </Text>
          <Text color="gray"> </Text>
          <Text bold>{info.name}</Text>
          <Text color="gray" dimColor>
            {' '}t:{info.toolCount} r:{info.resourceCount} p:{info.promptCount}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
