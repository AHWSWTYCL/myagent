import React, { createContext, useContext } from 'react'
import type { Tool, ToolRenderHeader } from '../tools/tool.js'

/**
 * React context 提供 name → Tool 实例的查找能力。
 * TUI 组件通过 useToolRender() 获取工具渲染方法，
 * 无需在每个组件 prop 中透传。
 */
const ToolRenderContext = createContext<Map<string, Tool> | null>(null)

export function ToolRenderProvider({ toolMap, children }: {
  toolMap: Map<string, Tool>
  children: React.ReactNode
}) {
  return (
    <ToolRenderContext.Provider value={toolMap}>
      {children}
    </ToolRenderContext.Provider>
  )
}

/**
 * 获取工具实例（不做渲染，返回原始 Tool 对象）。
 * 用于 TUI 组件从工具实例读取 side-channel 数据（如 TaskTool.lastListPayload）。
 */
export function useToolInstance(name: string): Tool | undefined {
  const map = useContext(ToolRenderContext)
  return map?.get(name)
}

/**
 * 根据工具名获取渲染信息。
 * 返回 { label, args } 头部渲染结果。
 * 找不到工具时退回默认格式。
 */
export function useToolRender(name: string, input: Record<string, unknown>): ToolRenderHeader {
  const map = useContext(ToolRenderContext)
  const tool = map?.get(name)
  if (tool) return tool.renderToolUseMessage(input)
  // 退回到默认行为
  const arg = Object.values(input).find(
    v => typeof v === 'string' && (v as string).length < 200,
  ) as string | undefined
  return {
    label: name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' '),
    args: arg ?? '',
  }
}

/**
 * 根据工具名获取结果渲染行。
 */
export function useToolResult(
  name: string,
  output: string,
  isError: boolean,
  input?: Record<string, unknown>,
): string[] {
  const map = useContext(ToolRenderContext)
  const tool = map?.get(name)
  if (tool) return tool.renderToolResult(output, isError, input)
  // 退回默认摘要
  return defaultSummarize(output, isError)
}

/**
 * 检查工具是否为探索工具（会被折叠进 TurnSummary）。
 */
export function useIsExplorationTool(name: string): boolean {
  const map = useContext(ToolRenderContext)
  const tool = map?.get(name)
  if (tool) return tool.isExplorationTool
  // 兼容旧版：硬编码探索工具列表
  return new Set(['read_file', 'list_dir', 'glob', 'grep']).has(name)
}

function defaultSummarize(output: string, isError: boolean): string[] {
  const trimmed = output.trimEnd()
  if (!trimmed) return []
  const lines = trimmed.split('\n')
  const trunc = (text: string, max: number) =>
    text.length <= max ? text : text.slice(0, max - 1) + '…'
  if (isError) return lines.slice(0, 4).map(l => trunc(l, 200))
  if (lines.length <= 4) return lines.map(l => trunc(l, 200))
  return [
    `${lines.length} lines`,
    trunc(lines[0], 200),
    trunc(lines[1], 200),
    '…',
    trunc(lines[lines.length - 1], 200),
  ]
}
