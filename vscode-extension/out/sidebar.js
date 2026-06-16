"use strict";
/**
 * sidebar.ts — Activity Bar 侧边栏视图
 *
 * 在活动栏显示 MyAgent 图标，点击后展示 MCP Server 状态和配置信息。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MyAgentSidebarProvider = void 0;
const vscode = __importStar(require("vscode"));
class MyAgentSidebarProvider {
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    port = 0;
    setPort(port) {
        this.port = port;
        this._onDidChangeTreeData.fire();
    }
    _version = '';
    setVersion(v) { this._version = v; }
    getTreeItem(element) {
        return element;
    }
    getChildren() {
        const items = [];
        // 状态行
        const status = new vscode.TreeItem(`$(circle-filled) myagent v${this._version} — port ${this.port}`, vscode.TreeItemCollapsibleState.None);
        status.tooltip = `Listening on ws://localhost:${this.port}`;
        items.push(status);
        // 配置提示
        const configHint = new vscode.TreeItem(`$(json) ~/.myagent/mcp-servers.json`, vscode.TreeItemCollapsibleState.None);
        configHint.description = 'Add this to connect';
        configHint.tooltip = [
            'Add the following to ~/.myagent/mcp-servers.json:',
            '',
            '{',
            '  "mcpServers": {',
            `    "vscode": {`,
            `      "url": "ws://localhost:${this.port}"`,
            '    }',
            '  }',
            '}',
        ].join('\n');
        configHint.command = {
            command: 'myagent-lsp.copyConfig',
            title: 'Copy Config',
        };
        items.push(configHint);
        // 工具列表
        const tools = new vscode.TreeItem(`$(tools) 9 MCP Tools`, vscode.TreeItemCollapsibleState.Collapsed);
        items.push(tools);
        return items;
    }
    getChildrenForTools() {
        return [
            { label: 'getOpenFiles', description: 'IDE — open files' },
            { label: 'getSelection', description: 'IDE — selected text' },
            { label: 'getActiveFile', description: 'IDE — active file' },
            { label: 'openFile', description: 'IDE — open file' },
            { label: 'getDiagnostics', description: 'IDE — errors/warnings' },
            { label: 'getExtensionLogs', description: 'IDE — console errors' },
            { label: 'executeCode', description: 'IDE — run command' },
            { label: 'showDiff', description: 'IDE — show file diff' },
            { label: 'showDiffInteractive', description: 'IDE — interactive diff' },
        ].map(t => {
            const item = new vscode.TreeItem(t.label, vscode.TreeItemCollapsibleState.None);
            item.description = t.description;
            return item;
        });
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
}
exports.MyAgentSidebarProvider = MyAgentSidebarProvider;
//# sourceMappingURL=sidebar.js.map