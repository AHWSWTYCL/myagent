/**
 * TaskRegistry — teammate 任务状态集中存储。
 *
 * 设计意图：
 *   - teammate 后台运行时，其状态对主 agent 不透明（只有 mailbox 文件）。
 *   - 这里提供一个内存注册表，TUI 从这里读取 teammate 的存活状态、工具调用数、
 *     邮箱未读数等，渲染 BackgroundTasksDialog。
 *   - 与 mailbox 互补：mailbox 是持久通信管道，registry 是实时状态快照。
 *
 * 生命周期：
 *   - spawn 时 register（agenttool.ts）
 *   - 每次 send_mail / check_mail 时 update（teammate.ts extraTools 注入）
 *   - 完成/退出时 update 为 killed/completed（bg notification）
 */

import EventEmitter from 'events'

export type TeammateTaskStatus = 'running' | 'idle' | 'completed' | 'failed' | 'killed'

export interface TeammateTaskInfo {
  /** teammate 的 agent_id（即 mailbox id） */
  agentId: string
  /** 所属 team（可选） */
  teamName?: string
  /** 角色描述 */
  role: string
  /** 当前状态 */
  status: TeammateTaskStatus
  /** 工具调用次数（teammate 端自行统计） */
  toolUseCount: number
  /** 邮箱中未读邮件数（teammate 端自行统计） */
  unreadCount: number
  /** 启动时间 */
  startTime: number
  /** 最后活跃时间 */
  lastActivity: number
  /** bgManager 中的 taskId（关联后台任务） */
  bgTaskId?: string
  /** 独立 transcript 文件路径（供 TeammateConversationView 重建对话） */
  transcriptPath?: string
}

class TaskRegistry extends EventEmitter {
  private tasks = new Map<string, TeammateTaskInfo>()

  /** 注册一个新 teammate。agentId 重复时覆盖。 */
  register(info: {
    agentId: string
    teamName?: string
    role: string
    toolUseCount?: number
    bgTaskId?: string
    transcriptPath?: string
  }): TeammateTaskInfo {
    const now = Date.now()
    const task: TeammateTaskInfo = {
      agentId: info.agentId,
      teamName: info.teamName,
      role: info.role,
      status: 'running',
      toolUseCount: info.toolUseCount ?? 0,
      unreadCount: 0,
      startTime: now,
      lastActivity: now,
      bgTaskId: info.bgTaskId,
      transcriptPath: info.transcriptPath,
    }
    this.tasks.set(info.agentId, task)
    this.emit('change', this.list())
    return task
  }

  /** 更新 teammate 状态（部分字段）。只传需要的字段即可。 */
  update(agentId: string, patch: Partial<Pick<TeammateTaskInfo, 'status' | 'toolUseCount' | 'unreadCount' | 'role' | 'teamName' | 'transcriptPath'>>): void {
    const task = this.tasks.get(agentId)
    if (!task) return
    Object.assign(task, patch, { lastActivity: Date.now() })
    this.emit('change', this.list())
  }

  /** 移除一个 teammate（完成/退出/被 kill）。 */
  remove(agentId: string): void {
    this.tasks.delete(agentId)
    this.emit('change', this.list())
  }

  /** 获取全部任务列表（按启动时间排序）。 */
  list(): TeammateTaskInfo[] {
    return [...this.tasks.values()].sort((a, b) => a.startTime - b.startTime)
  }

  /** 获取单个任务。 */
  get(agentId: string): TeammateTaskInfo | undefined {
    return this.tasks.get(agentId)
  }

  /** 清空全部（收尾用）。 */
  clear(): void {
    this.tasks.clear()
    this.emit('change', this.list())
  }
}

/** 全局唯一的 TaskRegistry 实例 */
export const taskRegistry = new TaskRegistry()
