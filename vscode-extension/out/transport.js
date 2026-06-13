"use strict";
/**
 * transport.ts — HTTP + SSE transport for VSCode MCP Server
 *
 * VSCode 插件内嵌 HTTP Server，提供:
 *   GET  /sse     → SSE event stream（myagent 通过 SSETransport 连接）
 *   POST /message → JSON-RPC 请求处理
 *
 * 端口策略: 固定端口 16888，写入 ~/.myagent/vscode-mcp.json 供 myagent 发现
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
exports.createTransport = createTransport;
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
// ── 端口持久化 ────────────────────────────────────────────────────────────────
const MYAGENT_DIR = path.join(os.homedir(), '.myagent');
const PORT_FILE = path.join(MYAGENT_DIR, 'vscode-mcp.json');
function ensureMyagentDir() {
    if (!fs.existsSync(MYAGENT_DIR)) {
        fs.mkdirSync(MYAGENT_DIR, { recursive: true });
    }
}
function writePortFile(port) {
    ensureMyagentDir();
    fs.writeFileSync(PORT_FILE, JSON.stringify({ port }));
}
function removePortFile() {
    try {
        fs.unlinkSync(PORT_FILE);
    }
    catch { /* ignore */ }
}
// ── 工厂函数 ──────────────────────────────────────────────────────────────────
function createTransport() {
    let server = null;
    let _port = 0;
    let sseClients = [];
    let callbacks = null;
    return {
        get port() { return _port; },
        async start(cbs) {
            callbacks = cbs;
            server = http.createServer((req, res) => {
                // CORS for local development
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                // GET /sse → SSE stream
                if (req.url === '/sse' && req.method === 'GET') {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'X-Accel-Buffering': 'no', // disable nginx buffering
                    });
                    // 立即发送 endpoint 事件，告诉 myagent POST 地址
                    res.write(`event: endpoint\ndata: http://localhost:${_port}/message\n\n`);
                    // 追踪连接，用于 clean shutdown
                    sseClients.push(res);
                    req.on('close', () => {
                        sseClients = sseClients.filter(c => c !== res);
                    });
                    return;
                }
                // POST /message → JSON-RPC
                if (req.url === '/message' && req.method === 'POST') {
                    let body = '';
                    req.on('data', (chunk) => {
                        body += chunk.toString('utf-8');
                    });
                    req.on('end', async () => {
                        try {
                            const result = await callbacks.onRequest(body);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(result);
                        }
                        catch (err) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                jsonrpc: '2.0',
                                id: null,
                                error: { code: -32700, message: `Parse error: ${err.message}` },
                            }));
                        }
                    });
                    return;
                }
                // 404
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            });
            // 动态端口
            await new Promise((resolve, reject) => {
                server.on('error', (err) => {
                    if (err.code === 'EADDRINUSE') {
                        reject(new Error(`Port 16888 is in use. Is another VSCode instance running?`));
                    }
                    else {
                        reject(err);
                    }
                });
                server.listen(16888, 'localhost', () => {
                    _port = 16888;
                    writePortFile(_port);
                    console.log(`[myagent] MCP Server listening on http://localhost:${_port}`);
                    resolve();
                });
            });
        },
        async stop() {
            removePortFile();
            // 关闭所有 SSE 连接
            for (const client of sseClients) {
                try {
                    client.end();
                }
                catch { /* ignore */ }
            }
            sseClients = [];
            // 关闭 HTTP server — 需要追踪并强制关闭活跃 socket
            if (server) {
                const sockets = new Set();
                server.on('connection', (socket) => sockets.add(socket));
                server.on('request', (_req, res) => {
                    res.on('close', () => {
                        if (res.socket)
                            sockets.delete(res.socket);
                    });
                });
                await new Promise((resolve) => {
                    server.close(() => resolve());
                    // 强制关闭活跃连接
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                });
                server = null;
            }
            _port = 0;
            callbacks = null;
        },
    };
}
//# sourceMappingURL=transport.js.map