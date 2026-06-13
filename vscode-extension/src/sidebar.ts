/**
 * sidebar.ts — Activity Bar 侧边栏视图
 *
 * 在活动栏显示 MyAgent 图标，点击后展示 MCP Server 状态和配置信息。
 */

import * as vscode from 'vscode'

export class MyAgentSidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private port: number = 0

  setPort(port: number) {
    this.port = port
    this._onDidChangeTreeData.fire()
  }

  private _version: string = ''
  setVersion(v: string) { this._version = v }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = []

    // 状态行
    const status = new vscode.TreeItem(
      `$(circle-filled) myagent v${this._version} — port ${this.port}`,
      vscode.TreeItemCollapsibleState.None,
    )
    status.tooltip = `Listening on http://localhost:${this.port}`
    items.push(status)

    // 配置提示
    const configHint = new vscode.TreeItem(
      `$(json) ~/.myagent/mcp-servers.json`,
      vscode.TreeItemCollapsibleState.None,
    )
    configHint.description = 'Add this to connect'
    configHint.tooltip = [
      'Add the following to ~/.myagent/mcp-servers.json:',
      '',
      '{',
      '  "mcpServers": {',
      `    "vscode": {`,
      `      "url": "http://localhost:${this.port}/sse"`,
      '    }',
      '  }',
      '}',
    ].join('\n')
    configHint.command = {
      command: 'myagent-lsp.copyConfig',
      title: 'Copy Config',
    }
    items.push(configHint)

    // 工具列表
    const tools = new vscode.TreeItem(
      `$(tools) 6 MCP Tools`,
      vscode.TreeItemCollapsibleState.Collapsed,
    )
    items.push(tools)

    return items
  }

  getChildrenForTools(): vscode.TreeItem[] {
    return [
      { label: 'getOpenFiles', description: 'IDE — open files' },
      { label: 'getSelection', description: 'IDE — selected text' },
      { label: 'getActiveFile', description: 'IDE — active file' },
      { label: 'openFile', description: 'IDE — open file' },
      { label: 'getDiagnostics', description: 'IDE — errors/warnings' },
      { label: 'executeCode', description: 'IDE — run command' },
    ].map(t => {
      const item = new vscode.TreeItem(t.label, vscode.TreeItemCollapsibleState.None)
      item.description = t.description
      return item
    })
  }

  refresh() {
    this._onDidChangeTreeData.fire()
  }
}
