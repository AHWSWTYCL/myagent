"use strict";
/**
 * extension.ts — VSCode Extension 入口
 *
 * 激活时启动 MCP HTTP Server，暴露 LSP + IDE 上下文工具给 myagent。
 * 端口写入 ~/.myagent/vscode-mcp.json。
 * 状态栏显示端口号。
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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const transport_1 = require("./transport");
const server_1 = require("./server");
const sidebar_1 = require("./sidebar");
const tools_1 = require("./tools");
let transport = null;
let statusBar = null;
let outputChannel = null;
let sidebarProvider = null;
async function activate(context) {
    const version = context.extension.packageJSON?.version ?? '0.0.0';
    outputChannel = vscode.window.createOutputChannel('myagent');
    outputChannel.appendLine(`[myagent] v${version} activating...`);
    try {
        transport = (0, transport_1.createTransport)();
        const server = (0, server_1.createMCPServer)(transport);
        await transport.start({
            onRequest: (body) => server.handleRequest(body),
            onClose: () => {
                outputChannel?.appendLine('[myagent] client disconnected');
            },
        });
        // 状态栏（左下角，和 Debug/Problems 同排）
        statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
        statusBar.text = `$(robot) myagent v${version}`;
        statusBar.tooltip = `MyAgent MCP Server running on port ${transport.port}\nConfigure in ~/.myagent/mcp-servers.json:\n{"vscode": {"url": "ws://localhost:${transport.port}"}}`;
        statusBar.show();
        // 活动栏 Sidebar（左侧图标列，和 Debug 并列）
        sidebarProvider = new sidebar_1.MyAgentSidebarProvider();
        sidebarProvider.setPort(transport.port);
        sidebarProvider.setVersion(version);
        context.subscriptions.push(vscode.window.registerTreeDataProvider('myagent-lsp-status', sidebarProvider));
        // 复制配置命令
        context.subscriptions.push(vscode.commands.registerCommand('myagent-lsp.copyConfig', () => {
            const config = JSON.stringify({
                mcpServers: {
                    vscode: { url: `ws://localhost:${transport.port}` }
                }
            }, null, 2);
            vscode.env.clipboard.writeText(config);
            vscode.window.showInformationMessage('MCP config copied to clipboard! Paste into ~/.myagent/mcp-servers.json');
        }));
        // 辅助：根据当前 active editor 更新 context key
        const updateDiffContext = () => {
            const activeUri = vscode.window.activeTextEditor?.document.uri.fsPath;
            let resolved;
            try {
                resolved = activeUri ? fs.realpathSync(activeUri) : undefined;
            }
            catch {
                resolved = activeUri;
            }
            const isActive = resolved
                ? [...tools_1.activeDiffTabs.values()].some(v => v.proposedPath === resolved)
                : false;
            vscode.commands.executeCommand('setContext', 'myagent.diffActive', isActive);
        };
        context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateDiffContext()));
        // 交互式 diff Accept/Reject 命令（editor/title 按钮调用）
        context.subscriptions.push(vscode.commands.registerCommand('myagent.diffAccept', () => {
            const activeUri = vscode.window.activeTextEditor?.document.uri.fsPath;
            let resolved;
            try {
                resolved = activeUri ? fs.realpathSync(activeUri) : undefined;
            }
            catch {
                resolved = activeUri;
            }
            const tabEntry = resolved
                ? [...tools_1.activeDiffTabs.entries()].find(([_, v]) => v.proposedPath === resolved)
                : undefined;
            if (tabEntry) {
                const [tabName,] = tabEntry;
                const cb = (0, tools_1.getDiffSession)(tabName);
                if (cb) {
                    (0, tools_1.removeDiffSession)(tabName);
                    cb('accepted');
                }
            }
        }));
        context.subscriptions.push(vscode.commands.registerCommand('myagent.diffReject', () => {
            const activeUri = vscode.window.activeTextEditor?.document.uri.fsPath;
            let resolved;
            try {
                resolved = activeUri ? fs.realpathSync(activeUri) : undefined;
            }
            catch {
                resolved = activeUri;
            }
            const tabEntry = resolved
                ? [...tools_1.activeDiffTabs.entries()].find(([_, v]) => v.proposedPath === resolved)
                : undefined;
            if (tabEntry) {
                const [tabName,] = tabEntry;
                const cb = (0, tools_1.getDiffSession)(tabName);
                if (cb) {
                    (0, tools_1.removeDiffSession)(tabName);
                    cb('rejected');
                }
            }
        }));
        // Prev/Next：复用 VS Code 内建 diff 导航
        context.subscriptions.push(vscode.commands.registerCommand('myagent.diffPrev', () => {
            vscode.commands.executeCommand('workbench.action.compareEditor.previousChange');
        }));
        context.subscriptions.push(vscode.commands.registerCommand('myagent.diffNext', () => {
            vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
        }));
        // 关闭所有活跃 diff（新 prompt 提交时 myagent 主进程调用）
        context.subscriptions.push(vscode.commands.registerCommand('myagent.closeAllDiffTabs', () => {
            (0, tools_1.closeAllDiffTabs)();
            updateDiffContext();
        }));
        outputChannel.appendLine(`[myagent] MCP Server started on http://localhost:${transport.port}`);
        outputChannel.appendLine(`[myagent] Port info written to ~/.myagent/vscode-mcp.json`);
    }
    catch (err) {
        outputChannel.appendLine(`[myagent] failed to start: ${err.message}`);
        vscode.window.showErrorMessage(`MyAgent LSP: ${err.message}`);
    }
    // 注册清理
    context.subscriptions.push({
        dispose: () => {
            transport?.stop().catch(() => { });
            transport = null;
            statusBar?.dispose();
            statusBar = null;
            outputChannel?.dispose();
            outputChannel = null;
        },
    });
    outputChannel.appendLine('[myagent] activated');
}
function deactivate() {
    outputChannel?.appendLine('[myagent] deactivating...');
    (0, tools_1.cleanupTempFiles)(true); // 强制清理所有 diff 临时文件
    transport?.stop().catch(() => { });
    transport = null;
    statusBar?.dispose();
    statusBar = null;
    outputChannel?.dispose();
    outputChannel = null;
}
//# sourceMappingURL=extension.js.map