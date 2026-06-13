/**
 * extension.ts — VSCode Extension 入口
 *
 * 激活时启动 MCP HTTP Server，暴露 LSP + IDE 上下文工具给 myagent。
 * 端口写入 ~/.myagent/vscode-mcp.json。
 * 状态栏显示端口号。
 */

import * as vscode from 'vscode'
import { createTransport, type MCPTransport } from './transport'
import { createMCPServer } from './server'
import { MyAgentSidebarProvider } from './sidebar'

let transport: MCPTransport | null = null
let statusBar: vscode.StatusBarItem | null = null
let outputChannel: vscode.OutputChannel | null = null
let sidebarProvider: MyAgentSidebarProvider | null = null

export async function activate(context: vscode.ExtensionContext) {
  const version = context.extension.packageJSON?.version ?? '0.0.0'
  outputChannel = vscode.window.createOutputChannel('myagent')
  outputChannel.appendLine(`[myagent] v${version} activating...`)

  try {
    transport = createTransport()
    const server = createMCPServer(transport)

    await transport.start({
      onRequest: (body) => server.handleRequest(body),
      onClose: () => {
        outputChannel?.appendLine('[myagent] client disconnected')
      },
    })

    // 状态栏（左下角，和 Debug/Problems 同排）
    statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      30,
    )
    statusBar.text = `$(robot) myagent v${version}`
    statusBar.tooltip = `MyAgent MCP Server running on port ${transport.port}\nConfigure in ~/.myagent/mcp-servers.json:\n{"vscode": {"url": "http://localhost:${transport.port}/sse"}}`
    statusBar.show()

    // 活动栏 Sidebar（左侧图标列，和 Debug 并列）
    sidebarProvider = new MyAgentSidebarProvider()
    sidebarProvider.setPort(transport.port)
    sidebarProvider.setVersion(version)
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('myagent-lsp-status', sidebarProvider)
    )

    // 复制配置命令
    context.subscriptions.push(
      vscode.commands.registerCommand('myagent-lsp.copyConfig', () => {
        const config = JSON.stringify({
          mcpServers: {
            vscode: { url: `http://localhost:${transport!.port}/sse` }
          }
        }, null, 2)
        vscode.env.clipboard.writeText(config)
        vscode.window.showInformationMessage('MCP config copied to clipboard! Paste into ~/.myagent/mcp-servers.json')
      })
    )

    outputChannel.appendLine(
      `[myagent] MCP Server started on http://localhost:${transport.port}`,
    )
    outputChannel.appendLine(
      `[myagent] Port info written to ~/.myagent/vscode-mcp.json`,
    )
  } catch (err: any) {
    outputChannel.appendLine(`[myagent] failed to start: ${err.message}`)
    vscode.window.showErrorMessage(`MyAgent LSP: ${err.message}`)
  }

  // 注册清理
  context.subscriptions.push({
    dispose: () => {
      transport?.stop().catch(() => {})
      transport = null
      statusBar?.dispose()
      statusBar = null
      outputChannel?.dispose()
      outputChannel = null
    },
  })

  outputChannel.appendLine('[myagent] activated')
}

export function deactivate() {
  outputChannel?.appendLine('[myagent] deactivating...')
  transport?.stop().catch(() => {})
  transport = null
  statusBar?.dispose()
  statusBar = null
  outputChannel?.dispose()
  outputChannel = null
}
