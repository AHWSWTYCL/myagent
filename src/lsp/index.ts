/**
 * LSP Manager 单例引用
 * 解决 EditTool/WriteTool 需要访问 lspManager 但存在循环依赖的问题。
 * bootstrap.ts 初始化后调用 setLSPManager() 注入。
 */
import type { LSPServerManager } from './LSPServerManager.js'

let _manager: LSPServerManager | undefined

export function setLSPManager(m: LSPServerManager): void {
  _manager = m
}

export function getLSPManager(): LSPServerManager | undefined {
  return _manager
}
