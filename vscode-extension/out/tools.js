"use strict";
/**
 * tools.ts — VSCode MCP 工具实现
 *
 * IDE 上下文工具 (4):
 *   getOpenFiles    — 当前打开的文件列表
 *   getSelection    — 当前选中文本
 *   getActiveFile   — 当前活跃文件信息
 *   openFile        — 打开指定文件并跳转到指定行列
 *
 * 诊断 & 执行工具 (2):
 *   getDiagnostics  — 获取 VSCode 诊断信息（错误/警告）
 *   executeCode     — 在 VSCode 终端执行命令
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
exports.getToolDefinitions = getToolDefinitions;
exports.executeToolAsync = executeToolAsync;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
function getToolDefinitions() {
    return [
        {
            name: 'getOpenFiles',
            description: 'Get the list of currently open files in the editor. ' +
                'Returns file paths and language IDs. Call-time snapshot.',
            inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
            name: 'getSelection',
            description: 'Get the currently selected text in the active editor. ' +
                'Returns file path, selection range, and selected text. Call-time snapshot.',
            inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
            name: 'getActiveFile',
            description: 'Get information about the currently active file. ' +
                'Returns file path, language ID, line count, and cursor position. Call-time snapshot.',
            inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
            name: 'openFile',
            description: 'Open a file in the editor. Optionally jump to a specific line/column. ' +
                'If no position given, opens at the beginning. line and character are 1-based.',
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute or relative file path' },
                    line: { type: 'number', description: '1-based line number to jump to' },
                    character: { type: 'number', description: '1-based character offset' },
                },
                required: ['filePath'],
            },
        },
        {
            name: 'getDiagnostics',
            description: 'Get diagnostic information from VSCode for the active file or all files. ' +
                'Returns errors, warnings, hints from language servers and linters.',
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Optional. Specific file path. If omitted, returns diagnostics for all open files.' },
                },
                required: [],
            },
        },
        {
            name: 'executeCode',
            description: 'Execute a shell command in the VSCode workspace directory. ' +
                'Returns stdout and stderr. Timeout defaults to 30 seconds. ' +
                'Use for build commands, tests, or code execution.',
            inputSchema: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Shell command to execute' },
                    timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
                },
                required: ['command'],
            },
        },
    ];
}
// ── 工具执行路由 ──────────────────────────────────────────────────────────────
async function executeToolAsync(name, args) {
    switch (name) {
        case 'getOpenFiles': return executeGetOpenFiles();
        case 'getSelection': return executeGetSelection();
        case 'getActiveFile': return executeGetActiveFile();
        case 'openFile': return await executeOpenFile(args);
        case 'getDiagnostics': return executeGetDiagnostics(args);
        case 'executeCode': return await executeCode(args);
        default: return `Error: Unknown tool "${name}"`;
    }
}
// ── 辅助 ──────────────────────────────────────────────────────────────────────
function resolvePath(filePath) {
    if (path.isAbsolute(filePath))
        return filePath;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.resolve(root, filePath) : path.resolve(filePath);
}
function toPosition(line, character) {
    return new vscode.Position(Math.max(0, line - 1), Math.max(0, character - 1));
}
// ── IDE 上下文操作 ─────────────────────────────────────────────────────────────
function executeGetOpenFiles() {
    const docs = vscode.workspace.textDocuments
        .filter((d) => d.uri.scheme === 'file')
        .map((d) => ({ path: d.uri.fsPath, languageId: d.languageId, isDirty: d.isDirty }));
    return docs.length === 0 ? 'No open files.' : JSON.stringify(docs, null, 2);
}
function executeGetSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return 'Error: No active editor';
    const s = editor.selection;
    return JSON.stringify({
        filePath: editor.document.uri.fsPath,
        languageId: editor.document.languageId,
        startLine: s.start.line + 1, startCharacter: s.start.character + 1,
        endLine: s.end.line + 1, endCharacter: s.end.character + 1,
        text: editor.document.getText(s),
    }, null, 2);
}
function executeGetActiveFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return 'Error: No active editor';
    const doc = editor.document;
    return JSON.stringify({
        path: doc.uri.fsPath, languageId: doc.languageId,
        lineCount: doc.lineCount, isDirty: doc.isDirty,
        cursor: { line: editor.selection.active.line + 1, character: editor.selection.active.character + 1 },
    }, null, 2);
}
async function executeOpenFile(args) {
    const filePath = resolvePath(args.filePath);
    const uri = vscode.Uri.file(filePath);
    try {
        await vscode.workspace.fs.stat(uri);
    }
    catch {
        return `Error: Unable to read file '${filePath}' (Error: Unable to resolve nonexistent file '${filePath}')`;
    }
    const line = args.line ? Math.max(1, args.line) : 1;
    const character = args.character ? Math.max(1, args.character) : 1;
    const editor = await vscode.window.showTextDocument(uri, { selection: new vscode.Range(toPosition(line, character), toPosition(line, character)), preview: false });
    const doc = editor.document;
    return JSON.stringify({ path: doc.uri.fsPath, languageId: doc.languageId, lineCount: doc.lineCount, cursor: { line, character } });
}
// ── 诊断 ──────────────────────────────────────────────────────────────────────
function executeGetDiagnostics(args) {
    let diagnostics;
    if (args.filePath) {
        const uri = vscode.Uri.file(resolvePath(args.filePath));
        diagnostics = [[uri, vscode.languages.getDiagnostics(uri)]];
    }
    else {
        diagnostics = vscode.languages.getDiagnostics();
    }
    const result = [];
    let totalErrors = 0, totalWarnings = 0, totalHints = 0;
    const severityLabels = {
        [vscode.DiagnosticSeverity.Error]: 'error',
        [vscode.DiagnosticSeverity.Warning]: 'warning',
        [vscode.DiagnosticSeverity.Information]: 'info',
        [vscode.DiagnosticSeverity.Hint]: 'hint',
    };
    for (const [uri, diags] of diagnostics) {
        if (diags.length === 0)
            continue;
        const entries = diags.map(d => {
            const sev = severityLabels[d.severity] ?? 'unknown';
            if (sev === 'error')
                totalErrors++;
            else if (sev === 'warning')
                totalWarnings++;
            else
                totalHints++;
            return {
                line: d.range.start.line + 1,
                column: d.range.start.character + 1,
                severity: sev,
                message: d.message,
                source: d.source ?? '',
                code: d.code ?? null,
            };
        });
        result.push({ file: uri.fsPath, count: entries.length, diagnostics: entries });
    }
    if (result.length === 0)
        return 'No diagnostics found.';
    return JSON.stringify({
        summary: { errors: totalErrors, warnings: totalWarnings, hints: totalHints, files: result.length },
        files: result,
    }, null, 2);
}
// ── 执行代码 ──────────────────────────────────────────────────────────────────
async function executeCode(args) {
    const command = args.command;
    const timeout = args.timeout ?? 30_000;
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return new Promise((resolve) => {
        const child = cp.exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && !stdout && !stderr) {
                resolve(JSON.stringify({ exitCode: error.code ?? 1, stdout: '', stderr: error.message }));
                return;
            }
            resolve(JSON.stringify({ exitCode: error?.code ?? 0, stdout, stderr }));
        });
    });
}
//# sourceMappingURL=tools.js.map