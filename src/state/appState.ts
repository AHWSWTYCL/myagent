import type { MCPServerInfo } from '../mcp/mcpmanager.js'
import type { TodoPlanSnapshot } from '../todos/todo.js'
import type { SubAgentTask } from '../tui/bridge.js'
import type { UsageStats } from '../tui/types.js'
import type { TeammateTaskInfo } from '../team/taskRegistry.js'
import { createStore, type Store } from './store.js'
import { onChangeAppState } from './onChangeAppState.js'

export type CompactingState = 'idle' | 'running' | 'micro'

export interface AppState {
  autoMode: boolean
  backgroundCount: number
  status: string
  usage: UsageStats | null
  compactingState: CompactingState
  mcpServers: MCPServerInfo[]
  subAgentTasks: SubAgentTask[]
  todoPlan: TodoPlanSnapshot | null
  teammateTasks: TeammateTaskInfo[]
  isProcessing: boolean
}

export type AppStateStore = Store<AppState>

export function getDefaultAppState(): AppState {
  return {
    autoMode: true,
    backgroundCount: 0,
    status: '',
    usage: null,
    compactingState: 'idle',
    mcpServers: [],
    subAgentTasks: [],
    todoPlan: null,
    teammateTasks: [],
    isProcessing: false,
  }
}

export const appStateStore = createStore<AppState>(getDefaultAppState(), onChangeAppState)
