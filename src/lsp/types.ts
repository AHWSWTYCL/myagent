/**
 * LSP 集成类型定义
 *
 * 定义 LSP 服务器配置、状态枚举和内置服务器列表。
 * MVP 硬编码 typescript-language-server，后续可扩展 ~/.myagent/lsp.json。
 */

// ── 服务器配置 ────────────────────────────────────────────────────────────────

export interface LSPServerConfig {
  /** 启动命令（如 'typescript-language-server'） */
  command: string
  /** 命令参数（如 ['--stdio']） */
  args?: string[]
  /** 额外的环境变量 */
  env?: Record<string, string>
  /** 工作区根目录（默认 process.cwd()） */
  workspaceFolder?: string
  /** 文件扩展名 → languageId 映射 */
  extensionToLanguage: Record<string, string>
  /** 启动超时（毫秒），默认 15_000 */
  startupTimeout?: number
}

// ── 服务器状态 ────────────────────────────────────────────────────────────────

/**
 * LSP 服务器状态机：
 *   stopped → starting → running → stopping → stopped
 *   任何状态 ──失败──→ error
 *   error ──start()──→ starting
 */
export type LSPState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

// ── 内置服务器 ────────────────────────────────────────────────────────────────

/**
 * 内置 LSP 服务器配置。
 * typescript-language-server 可通过 npm 安装：npm i -g typescript-language-server
 * 要求 Node.js >= 18，依赖 tsc 在 PATH 中。
 */
export const BUILTIN_SERVERS: Record<string, LSPServerConfig> = {
  'typescript-language-server': {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
    },
    startupTimeout: 15_000,
  },
}
