/**
 * !mcp 命令处理器
 *
 * 通过 `!mcp list` / `!mcp status <name>` / `!mcp reconnect <name>` / `!mcp disconnect <name>`
 * 查看和管理 MCP Server。
 */

import type { MCPManager, MCPServerInfo } from '../mcp/mcpmanager.js'

// ── 命令处理 ──────────────────────────────────────────────────────────────────

/**
 * 处理 !mcp 命令。
 *
 * @param args    子命令及参数，如 "list" 或 "status myserver"
 * @param manager MCPManager 实例（可能为 undefined）
 * @returns 显示文本
 */
export async function handleMCPCommand(
  args: string,
  manager: MCPManager | undefined,
): Promise<string> {
  if (!manager) {
    return 'MCP is not available (MCP Manager not initialized)'
  }

  const parts = args.trim().split(/\s+/)
  const subcommand = parts[0]?.toLowerCase() ?? ''

  switch (subcommand) {
    case 'list':
      return cmdList(manager)

    case 'status': {
      const name = parts.slice(1).join(' ')
      if (!name) return 'Usage: !mcp status <server-name>'
      return cmdStatus(manager, name)
    }

    case 'reconnect': {
      const name = parts.slice(1).join(' ')
      if (!name) return 'Usage: !mcp reconnect <server-name>'
      return cmdReconnect(manager, name)
    }

    case 'disconnect': {
      const name = parts.slice(1).join(' ')
      if (!name) return 'Usage: !mcp disconnect <server-name>'
      return cmdDisconnect(manager, name)
    }

    default:
      return helpText()
  }
}

// ── 子命令实现 ────────────────────────────────────────────────────────────────

function cmdList(manager: MCPManager): string {
  const infos = manager.getServerInfos()

  if (infos.length === 0) {
    return 'No MCP servers configured.'
  }

  const lines: string[] = []
  lines.push('MCP Servers:')
  lines.push('')

  // 表头
  const header = ['Name', 'Status', 'Transport', 'Tools', 'Res', 'Prompts']
  const widths = [20, 14, 10, 6, 6, 8]

  function fmtRow(cols: string[]): string {
    return '  ' + cols.map((c, i) => c.padEnd(widths[i])).join(' ')
  }

  lines.push(fmtRow(header))
  lines.push('  ' + widths.map(w => '─'.repeat(w)).join(' '))

  for (const info of infos) {
    const statusColor = statusLabel(info.status)
    lines.push(fmtRow([
      info.name.slice(0, 18),
      statusColor,
      info.transport,
      String(info.toolCount),
      String(info.resourceCount),
      String(info.promptCount),
    ]))
  }

  lines.push('')
  lines.push(`${infos.filter(i => i.status === 'connected').length} connected, ${infos.filter(i => i.status === 'error').length} failed`)

  return lines.join('\n')
}

function cmdStatus(manager: MCPManager, name: string): string {
  const infos = manager.getServerInfos()
  const info = infos.find(i => i.name === name)

  if (!info) {
    return `Server "${name}" not found. Use !mcp list to see available servers.`
  }

  const lines: string[] = []
  lines.push(`Server:    ${info.name}`)
  lines.push(`Status:    ${statusLabel(info.status)}`)
  lines.push(`Transport: ${info.transport}`)

  if (info.serverInfo) {
    lines.push(`Server Info: ${info.serverInfo.name} v${info.serverInfo.version}`)
  }

  lines.push('')
  lines.push(`Tools:     ${info.toolCount > 0 ? `${info.toolCount} tool(s) registered` : '(none)'}`)
  lines.push(`Resources: ${info.resourceCount > 0 ? `${info.resourceCount} resource(s)` : '(none)'}`)
  lines.push(`Prompts:   ${info.promptCount > 0 ? `${info.promptCount} prompt(s)` : '(none)'}`)

  return lines.join('\n')
}

async function cmdReconnect(manager: MCPManager, name: string): Promise<string> {
  const infos = manager.getServerInfos()
  if (!infos.find(i => i.name === name)) {
    return `Server "${name}" not found. Use !mcp list to see available servers.`
  }

  await manager.reconnect(name)

  // 重新获取状态
  const updated = manager.getServerInfos().find(i => i.name === name)
  if (updated?.status === 'connected') {
    return `✅ Reconnected to "${name}" (${updated.toolCount} tools, ${updated.resourceCount} resources, ${updated.promptCount} prompts)`
  }
  return `❌ Failed to reconnect to "${name}". Check server configuration.`
}

async function cmdDisconnect(manager: MCPManager, name: string): Promise<string> {
  const infos = manager.getServerInfos()
  if (!infos.find(i => i.name === name)) {
    return `Server "${name}" not found. Use !mcp list to see available servers.`
  }

  await manager.disconnect(name)
  return `Disconnected from "${name}".`
}

function helpText(): string {
  return [
    'Usage: !mcp <command> [args]',
    '',
    'Commands:',
    '  list                          List all MCP servers and their status',
    '  status <server-name>          Show detailed info for a server',
    '  reconnect <server-name>       Reconnect a disconnected server',
    '  disconnect <server-name>      Disconnect a server',
    '',
    'Examples:',
    '  !mcp list',
    '  !mcp status filesystem',
    '  !mcp reconnect filesystem',
  ].join('\n')
}

// ── 辅助 ──────────────────────────────────────────────────────────────────────

function statusLabel(status: string): string {
  switch (status) {
    case 'connected':    return '● connected'
    case 'connecting':   return '◐ connecting'
    case 'error':        return '✗ error'
    case 'disconnected': return '○ disconnected'
    default:             return status
  }
}
