import type { MCPServerInfo } from '../mcp/mcpmanager.js'
import type { TodoPlanSnapshot } from '../todos/todo.js'
import type { SubAgentTask } from '../tui/bridge.js'
import type { UsageStats } from '../tui/types.js'
import type { TeammateTaskInfo } from '../team/taskRegistry.js'
import { createStore, type Store } from './store.js'
import { onChangeAppState } from './onChangeAppState.js'

export type CompactingState = 'idle' | 'running' | 'micro'

/** Agent 交互模式 */
export type AgentMode = 'default' | 'auto' | 'plan'

export interface AppState {
  /** 当前交互模式：default(手动确认) | auto(AI 自动授权) | plan(只读探索计划) */
  mode: AgentMode
  backgroundCount: number
  status: string
  usage: UsageStats | null
  compactingState: CompactingState
  mcpServers: MCPServerInfo[]
  subAgentTasks: SubAgentTask[]
  todoPlan: TodoPlanSnapshot | null
  teammateTasks: TeammateTaskInfo[]
  isProcessing: boolean
  /** 进入 plan mode 前的 mode，退出时恢复 */
  planPreviousMode: 'default' | 'auto' | null
  /** plan mode 下的 query 计数，用于控制 prompt 注入频率 */
  planQueryCount: number
}

export type AppStateStore = Store<AppState>

export function getDefaultAppState(): AppState {
  return {
    mode: 'auto',
    backgroundCount: 0,
    status: '',
    usage: null,
    compactingState: 'idle',
    mcpServers: [],
    subAgentTasks: [],
    todoPlan: null,
    teammateTasks: [],
    isProcessing: false,
    planPreviousMode: null,
    planQueryCount: 0,
  }
}

export const appStateStore = createStore<AppState>(getDefaultAppState(), onChangeAppState)
