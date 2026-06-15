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
 * 诊断 & 执行工具 (3):
 *   getDiagnostics  — 获取 VSCode 诊断信息（错误/警告）
 *   executeCode     — 在 VSCode 终端执行命令
 *   showDiff        — 在 VSCode 中展示文件 diff
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
exports.activeDiffTabs = void 0;
exports.getToolDefinitions = getToolDefinitions;
exports.executeToolAsync = executeToolAsync;
exports.cleanupTempFiles = cleanupTempFiles;
exports.getDiffSession = getDiffSession;
exports.removeDiffSession = removeDiffSession;
exports.closeAllDiffTabs = closeAllDiffTabs;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
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
        {
            name: 'showDiff',
            description: 'Show a diff view in VSCode for a file. ' +
                'If oldContent and newContent are provided, they are used directly. ' +
                'Otherwise, uses "git show HEAD" to get the old version and compares ' +
                'against the current file on disk. For new (untracked) files, old ' +
                'content is treated as empty.',
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute or relative file path' },
                    oldContent: { type: 'string', description: 'Optional. Old file content (before edit). If omitted, uses git HEAD.' },
                    newContent: { type: 'string', description: 'Optional. New file content (after edit). If omitted, reads current file from disk.' },
                },
                required: ['filePath'],
            },
        },
        {
            name: 'showDiffInteractive',
            description: 'Show an interactive diff view in VSCode and wait for user action. ' +
                'Left side: real file on disk (read-only). Right side: proposed changes (editable). ' +
                'Blocks until user clicks Accept/Reject or the request times out (2 min). ' +
                'If user modifies and saves the right side, the modified content is returned.',
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute or relative file path' },
                    newContent: { type: 'string', description: 'Proposed new file content to show on the right side' },
                },
                required: ['filePath', 'newContent'],
            },
        },
        {
            name: 'closeFile',
            description: 'Close a file tab in the IDE. ' +
                'Accepts a filePath and closes all tabs (diff views and regular editors) ' +
                'that reference that file. Safe to call on files that are not open.',
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute or relative file path to close' },
                },
                required: ['filePath'],
            },
        },
        {
            name: 'closeAllDiffTabs',
            description: 'Close all active diff review tabs. ' +
                'Rejects all pending interactive diffs and cleans up temp files. ' +
                'Called when a new prompt is submitted to clear stale diff views.',
            inputSchema: { type: 'object', properties: {}, required: [] },
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
        case 'showDiff': return await executeShowDiff(args);
        case 'showDiffInteractive': return await executeShowDiffInteractive(args);
        case 'closeFile': return await executeCloseFile(args);
        case 'closeAllDiffTabs': return executeCloseAllDiffTabs();
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
        cp.exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && !stdout && !stderr) {
                resolve(JSON.stringify({ exitCode: error.code ?? 1, stdout: '', stderr: error.message }));
                return;
            }
            resolve(JSON.stringify({ exitCode: error?.code ?? 0, stdout, stderr }));
        });
    });
}
// ── Diff 展示 ─────────────────────────────────────────────────────────────────
/**
 * 已知的二进制文件扩展名。这些文件的 diff 没有可读性，跳过展示。
 */
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
    '.wasm', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.o', '.a', '.lib',
    '.pdf', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.db', '.sqlite', '.sqlite3',
]);
/** Diff 内容总大小上限（old + new），超出则跳过。 */
const MAX_DIFF_CONTENT_SIZE = 500 * 1024; // 500KB
/**
 * 临时文件跟踪：记录为 showDiff 创建的临时文件，用于延迟清理。
 */
const _tempFiles = [];
/**
 * 清理旧的临时文件（超过 5 分钟的）。
 * 导出供 extension.ts deactivate() 调用，扩展卸载时强制清理所有临时文件。
 */
function cleanupTempFiles(forceAll = false) {
    const now = Date.now();
    const remaining = [];
    for (const entry of _tempFiles) {
        try {
            if (forceAll || now - entry.createdAt > 5 * 60 * 1000) {
                fs.unlinkSync(entry.path);
            }
            else {
                remaining.push(entry);
            }
        }
        catch {
            // 文件已不存在，跳过
        }
    }
    _tempFiles.length = 0;
    if (!forceAll)
        _tempFiles.push(...remaining);
}
/**
 * 将内容写入临时文件，返回文件路径。
 * 文件名包含时间戳和原始文件名以避免并发覆盖。
 */
function writeTempFile(originalPath, content, suffix) {
    cleanupTempFiles();
    const basename = path.basename(originalPath);
    const tmpDir = os.tmpdir();
    const random = Math.random().toString(36).slice(2, 8);
    const tmpName = `.myagent-diff-${Date.now()}-${random}-${basename}.${suffix}`;
    const tmpPath = path.join(tmpDir, tmpName);
    fs.writeFileSync(tmpPath, content, 'utf-8');
    _tempFiles.push({ path: tmpPath, createdAt: Date.now() });
    return tmpPath;
}
async function executeShowDiff(args) {
    const filePath = resolvePath(args.filePath);
    const providedOld = args.oldContent;
    const providedNew = args.newContent;
    // ── 二进制文件跳过 ──────────────────────────────────────────────────
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
        return JSON.stringify({ shown: false, reason: `Binary file (${ext}), diff skipped` });
    }
    // ── 大文件跳过 ──────────────────────────────────────────────────────
    const totalSize = (providedOld?.length ?? 0) + (providedNew?.length ?? 0);
    if (totalSize > MAX_DIFF_CONTENT_SIZE) {
        return JSON.stringify({ shown: false, reason: `Content too large (${Math.round(totalSize / 1024)}KB), diff skipped` });
    }
    let oldContent;
    let newContent;
    let leftLabel;
    let rightLabel;
    // ── 确定新旧内容 ────────────────────────────────────────────────────
    if (providedOld !== undefined && providedNew !== undefined) {
        // 直接使用传入的内容（来自 edit_file 的 diff 数据）
        oldContent = providedOld;
        newContent = providedNew;
        leftLabel = `${path.basename(filePath)} (before)`;
        rightLabel = `${path.basename(filePath)} (after)`;
    }
    else {
        // 从磁盘读取当前文件作为 newContent
        try {
            newContent = fs.readFileSync(filePath, 'utf-8');
        }
        catch {
            return `Error: Unable to read file '${filePath}'`;
        }
        if (providedOld !== undefined) {
            oldContent = providedOld;
        }
        else {
            // 尝试从 git 获取旧版本
            const gitResult = await gitShowHead(filePath);
            if (gitResult !== null) {
                oldContent = gitResult;
            }
            else {
                // 新文件（untracked），旧内容为空
                oldContent = '';
            }
        }
        if (providedNew !== undefined) {
            newContent = providedNew;
        }
        leftLabel = `${path.basename(filePath)} (HEAD)`;
        rightLabel = `${path.basename(filePath)} (working)`;
    }
    // ── 无差异时跳过 ────────────────────────────────────────────────────
    if (oldContent === newContent) {
        return JSON.stringify({ shown: false, reason: 'No changes to display' });
    }
    // ── 写临时文件并打开 diff 视图 ─────────────────────────────────────
    const leftPath = writeTempFile(filePath, oldContent, 'old');
    const rightPath = writeTempFile(filePath, newContent, 'new');
    const leftUri = vscode.Uri.file(leftPath);
    const rightUri = vscode.Uri.file(rightPath);
    const title = `${path.basename(filePath)}: Diff`;
    try {
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
    }
    catch (err) {
        return `Error: Failed to open diff view: ${err.message}`;
    }
    // 同时打开右侧文件（新版本）作为普通编辑器，方便编辑
    const fileUri = vscode.Uri.file(filePath);
    try {
        await vscode.window.showTextDocument(fileUri, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }
    catch {
        // 打开文件失败不影响 diff 展示
    }
    return JSON.stringify({ shown: true, filePath, leftLabel, rightLabel });
}
/**
 * 使用 git show HEAD:path 获取文件的 HEAD 版本内容。
 * 返回 null 表示获取失败（文件不存在于 git、不是 git 仓库等）。
 */
function gitShowHead(filePath) {
    return new Promise((resolve) => {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
        // 先获取 git 仓库根目录（支持 monorepo/submodule）
        cp.exec('git rev-parse --show-toplevel', { cwd: wsRoot, timeout: 5000 }, (err, gitRoot) => {
            if (err) {
                resolve(null); // 不是 git 仓库
                return;
            }
            const gitRootClean = gitRoot.trim();
            const relativePath = path.relative(gitRootClean, filePath);
            cp.exec(`git show HEAD:"${relativePath}"`, { cwd: gitRootClean, timeout: 5000 }, (error, stdout) => {
                if (error) {
                    resolve(null); // 文件不在 git 中
                    return;
                }
                resolve(stdout);
            });
        });
    });
}
// ── 交互式 Diff（阻塞等待用户操作）──────────────────────────────────────────
//
// 设计：与 Claude Code 一致，用唯一 tab 名称标识每个 diff 视图。
// Accept/Reject/关闭时按 tab.label 精确匹配，避免跨平台路径规范化问题。
/** 交互式 diff 的超时时间（毫秒），超时后自动 reject。 */
const INTERACTIVE_DIFF_TIMEOUT = 2 * 60 * 1000; // 2 min
/** diff session 回调，key 为 tabName */
const diffSessions = new Map();
/**
 * 活跃 diff tab 元数据。
 * tabName → { proposedPath }
 * 供 editor/title 按钮（extension.ts）和 close 逻辑使用。
 */
exports.activeDiffTabs = new Map();
function getDiffSession(tabName) {
    return diffSessions.get(tabName);
}
function removeDiffSession(tabName) {
    diffSessions.delete(tabName);
}
/** 关闭所有活跃 diff tab（新请求到来时调用） */
function closeAllDiffTabs() {
    // 先 reject 所有 session，触发各自 Promise resolve
    for (const [tabName, cb] of diffSessions) {
        try {
            cb('rejected');
        }
        catch { /* ignore */ }
    }
    diffSessions.clear();
    // 关闭所有关联 tab
    for (const [tabName, { proposedPath }] of exports.activeDiffTabs) {
        closeTabByName(tabName, proposedPath).catch(() => { });
        try {
            fs.unlinkSync(proposedPath);
        }
        catch { /* ignore */ }
    }
    exports.activeDiffTabs.clear();
}
/** 生成唯一 tab 名称，对齐 Claude Code 风格 */
function makeTabName(originalBasename) {
    const random = Math.random().toString(36).slice(2, 8);
    return `✻ [myagent] ${originalBasename} (${random})`;
}
/** 按 tab 名称关闭对应的 tab（diff 视图 + proposed 编辑器） */
async function closeTabByName(tabName, proposedPath) {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            // diff 视图：按 tab.label 精确匹配
            if (tab.label === tabName) {
                try {
                    await vscode.window.tabGroups.close(tab);
                }
                catch { /* already closed */ }
                continue;
            }
            // proposed 文件编辑器：按 URI 路径匹配
            // TabInputTextDiff 使用 modified，TabInputText 使用 uri
            const input = tab.input;
            const tabPath = input?.uri?.fsPath ?? input?.modified?.fsPath;
            if (tabPath === proposedPath) {
                try {
                    await vscode.window.tabGroups.close(tab);
                }
                catch { /* already closed */ }
            }
        }
    }
}
async function executeShowDiffInteractive(args) {
    cleanupTempFiles();
    const filePath = resolvePath(args.filePath);
    const newContent = args.newContent;
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
        return JSON.stringify({ action: 'skip', reason: `Binary file (${ext})` });
    }
    let oldContent;
    try {
        oldContent = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        oldContent = '';
    }
    if (oldContent === newContent) {
        return JSON.stringify({ action: 'skip', reason: 'No changes' });
    }
    const basename = path.basename(filePath);
    // ── 写右侧临时文件（proposed content）──────────────────────────────
    const tmpDir = os.tmpdir();
    const random = Math.random().toString(36).slice(2, 8);
    const proposedName = `.myagent-proposed-${Date.now()}-${random}-${basename}`;
    let proposedPath = path.join(tmpDir, proposedName);
    fs.writeFileSync(proposedPath, newContent, 'utf-8');
    try {
        proposedPath = fs.realpathSync(proposedPath);
    }
    catch { /* ignore */ }
    _tempFiles.push({ path: proposedPath, createdAt: Date.now() });
    // ── 生成唯一 tab 名称并注册元数据 ──────────────────────────────────
    const tabName = makeTabName(basename);
    exports.activeDiffTabs.set(tabName, { proposedPath });
    // ── 打开 diff 视图 ──────────────────────────────────────────────────
    const leftUri = vscode.Uri.file(filePath);
    const rightUri = vscode.Uri.file(proposedPath);
    try {
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, tabName);
    }
    catch (err) {
        try {
            fs.unlinkSync(proposedPath);
        }
        catch { /* ignore */ }
        exports.activeDiffTabs.delete(tabName);
        return JSON.stringify({ action: 'error', error: `Failed to open diff: ${err.message}` });
    }
    // ── settled / cleanup ────────────────────────────────────────────────
    let settled = false;
    const cleanup = async () => {
        if (settled)
            return;
        settled = true;
        removeDiffSession(tabName);
        exports.activeDiffTabs.delete(tabName);
        await closeTabByName(tabName, proposedPath);
        try {
            await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
        }
        catch { /* ignore */ }
        try {
            fs.unlinkSync(proposedPath);
        }
        catch { /* ignore */ }
    };
    // ── 等待用户操作 ────────────────────────────────────────────────────
    return new Promise((resolve) => {
        let disposables = [];
        const done = async (result) => {
            for (const d of disposables)
                d.dispose();
            const action = result.action;
            if (action === 'accepted') {
                try {
                    fs.writeFileSync(filePath, newContent, 'utf-8');
                }
                catch { /* ignore */ }
            }
            else if (action === 'modified') {
                const mc = result.newContent;
                if (mc !== undefined) {
                    try {
                        fs.writeFileSync(filePath, mc, 'utf-8');
                    }
                    catch { /* ignore */ }
                }
            }
            await cleanup();
            resolve(JSON.stringify(result));
        };
        // CodeLens Accept/Reject 回调
        diffSessions.set(tabName, (action) => {
            if (settled)
                return;
            done({ action });
        });
        // 保存监听
        const saveListener = vscode.workspace.onDidSaveTextDocument(doc => {
            if (settled || doc.uri.fsPath !== proposedPath)
                return;
            try {
                const modifiedContent = fs.readFileSync(proposedPath, 'utf-8');
                done({ action: 'modified', newContent: modifiedContent });
            }
            catch (err) {
                done({ action: 'error', error: `Failed to read: ${err.message}` });
            }
        });
        // ── 关闭监听：按 tab.label 精确匹配（Claude Code 风格）─────────
        const tabListener = vscode.window.tabGroups.onDidChangeTabs(e => {
            if (settled)
                return;
            for (const closed of e.closed) {
                if (closed.label === tabName ||
                    closed.input?.uri?.fsPath === proposedPath) {
                    done({ action: 'accepted' });
                    return;
                }
            }
        });
        // 超时
        const timer = setTimeout(() => {
            if (!settled)
                done({ action: 'rejected', reason: 'Timeout' });
        }, INTERACTIVE_DIFF_TIMEOUT);
        disposables = [
            saveListener,
            tabListener,
            { dispose: () => clearTimeout(timer) },
        ];
    });
}
// ── closeFile 工具：按文件路径关闭 IDE 标签页 ──────────────────────────────
async function executeCloseFile(args) {
    const targetPath = resolvePath(args.filePath);
    const targetBasename = path.basename(targetPath);
    let closed = 0;
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            let match = false;
            // 按 label 模糊匹配（覆盖 "✻ Review: foo.ts (abc123)" 等 diff 视图）
            if (tab.label.includes(targetBasename)) {
                match = true;
            }
            // 按 input URI 精确匹配（普通编辑器 tab）
            if (!match) {
                const input = tab.input;
                const uris = [input?.original?.fsPath, input?.modified?.fsPath, input?.uri?.fsPath];
                if (uris.some(u => u === targetPath)) {
                    match = true;
                }
            }
            if (match) {
                try {
                    await vscode.window.tabGroups.close(tab);
                    closed++;
                }
                catch { /* ignore */ }
            }
        }
    }
    return JSON.stringify({ closed, filePath: targetPath });
}
// ── closeAllDiffTabs 工具 ─────────────────────────────────────────────────
function executeCloseAllDiffTabs() {
    closeAllDiffTabs();
    return JSON.stringify({ closed: true });
}
//# sourceMappingURL=tools.js.map