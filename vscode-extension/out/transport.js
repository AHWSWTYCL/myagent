"use strict";
/**
 * transport.ts — WebSocket transport for VSCode MCP Server
 *
 * VSCode 插件内嵌 WebSocket Server，提供:
 *   ws://localhost:16888 → JSON-RPC 双向通信
 *
 * WebSocket 自带 ping/pong 保活（ws 库默认每 30s），无需应用层心跳。
 * 端口写入 ~/.myagent/vscode-mcp.json 供 myagent 发现。
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
const ws_1 = require("ws");
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
    let wss = null;
    let _port = 0;
    let _currentClient = null;
    let callbacks = null;
    return {
        get port() { return _port; },
        async start(cbs) {
            callbacks = cbs;
            wss = new ws_1.WebSocketServer({ port: 16888, host: 'localhost' });
            wss.on('listening', () => {
                _port = 16888;
                writePortFile(_port);
                console.log(`[myagent] WebSocket MCP Server listening on ws://localhost:${_port}`);
            });
            wss.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.error(`[myagent] Port 16888 is in use. Is another VSCode instance running?`);
                }
                else {
                    console.error(`[myagent] WebSocket server error: ${err.message}`);
                }
            });
            wss.on('connection', (ws) => {
                // 只允许一个客户端连接；新连接踢掉旧连接
                if (_currentClient) {
                    console.log('[myagent] New client connected, closing old connection');
                    try {
                        _currentClient.close(1000, 'new client connected');
                    }
                    catch { /* ignore */ }
                }
                _currentClient = ws;
                console.log('[myagent] MCP client connected');
                ws.on('message', async (data) => {
                    try {
                        const response = await callbacks.onRequest(data.toString());
                        if (ws.readyState === ws_1.WebSocket.OPEN) {
                            ws.send(response);
                        }
                    }
                    catch (err) {
                        console.error(`[myagent] Request handling error: ${err.message}`);
                        if (ws.readyState === ws_1.WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                jsonrpc: '2.0',
                                id: null,
                                error: { code: -32700, message: `Parse error: ${err.message}` },
                            }));
                        }
                    }
                });
                ws.on('close', (code, reason) => {
                    console.log(`[myagent] MCP client disconnected (code=${code}, reason=${reason?.toString() || 'none'})`);
                    if (_currentClient === ws) {
                        _currentClient = null;
                    }
                    callbacks?.onClose();
                });
                ws.on('error', (err) => {
                    console.error(`[myagent] WebSocket client error: ${err.message}`);
                });
            });
            // 等待 server 启动
            await new Promise((resolve, reject) => {
                if (wss.address()) {
                    resolve();
                    return;
                }
                wss.once('listening', () => resolve());
                wss.once('error', (err) => reject(err));
            });
        },
        async stop() {
            // 关闭当前客户端连接
            if (_currentClient) {
                try {
                    _currentClient.close(1000, 'server shutting down');
                }
                catch { /* ignore */ }
                _currentClient = null;
            }
            // 关闭 WebSocket server
            const server = wss;
            if (server) {
                await new Promise((resolve) => {
                    server.close(() => resolve());
                    // 强制关闭所有连接
                    for (const client of server.clients) {
                        client.terminate();
                    }
                });
                wss = null;
            }
            removePortFile();
            _port = 0;
            callbacks = null;
        },
    };
}
//# sourceMappingURL=transport.js.map