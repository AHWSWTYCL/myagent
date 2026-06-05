/**
 * backgroundManager — 后台任务生命周期管理
 *
 * 设计意图：
 *   后台 fork 完成后会上报结果，但运行中是无状态的裸 Promise。
 *   这里提供一个中心化的管理器来追踪所有后台任务（运行中 + 已完成），
 *   供 /bg list / bg show / bg kill 命令查询和操作。
 *
 * 使用方式（单例）：
 *   import { bgManager } from './backgroundManager.js'
 *   const { id, abortController } = bgManager.start('task description')
 *   // ... fork loop with abortController.signal ...
 *   bgManager.complete(id, outputPath, summary)
 *   // or bgManager.fail(id, errorMessage)
 */

import { generateBgTaskId } from './backgroundStorage.js'

export type BgTaskStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface BgTaskInfo {
  id: string
  description: string
  status: BgTaskStatus
  startTime: number
  endTime?: number
  /** 输出文件路径（相对 cwd），completed/failed 后才有 */
  outputPath?: string
  /** 一行摘要，completed 后才有 */
  summary?: string
  /** 错误信息，failed 后才有 */
  error?: string
}

class BackgroundManager {
  private tasks = new Map<string, BgTaskInfo>()
  /** 运行中任务的 AbortController 映射 */
  private controllers = new Map<string, AbortController>()

  /**
   * 注册一个新后台任务。
   * @returns taskId 和对应的 AbortController（用于 kill）
   */
  start(description: string): { id: string; abortController: AbortController } {
    const id = generateBgTaskId()
    const abortController = new AbortController()
    this.tasks.set(id, {
      id,
      description,
      status: 'running',
      startTime: Date.now(),
    })
    this.controllers.set(id, abortController)
    return { id, abortController }
  }

  /**
   * 标记后台任务完成。
   * 注意：如果任务已被 kill() 手动中止，不覆盖 killed 状态。
   */
  complete(id: string, outputPath: string, summary: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    // 已被用户手动 kill 的，保持 killed 状态
    if (task.status === 'killed') return
    task.status = 'completed'
    task.endTime = Date.now()
    task.outputPath = outputPath
    task.summary = summary
    this.controllers.delete(id)
  }

  /**
   * 标记后台任务失败。
   * 注意：如果任务已被 kill() 手动中止，不覆盖 killed 状态。
   */
  fail(id: string, error: string, outputPath?: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    // 已被用户手动 kill 的，保持 killed 状态
    if (task.status === 'killed') return
    task.status = 'failed'
    task.endTime = Date.now()
    task.error = error
    if (outputPath) task.outputPath = outputPath
    this.controllers.delete(id)
  }

  /**
   * 获取所有任务（按开始时间降序）。
   */
  list(): BgTaskInfo[] {
    return [...this.tasks.values()].sort((a, b) => b.startTime - a.startTime)
  }

  /**
   * 获取单个任务详情。
   */
  get(id: string): BgTaskInfo | undefined {
    return this.tasks.get(id)
  }

  /**
   * 中止一个运行中的后台任务。
   * @returns true 表示成功中止，false 表示任务不存在或未在运行
   */
  kill(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'running') return false
    task.status = 'killed'
    task.endTime = Date.now()
    const ctrl = this.controllers.get(id)
    ctrl?.abort()
    this.controllers.delete(id)
    return true
  }
}

/** 全局唯一的 BackgroundManager 实例 */
export const bgManager = new BackgroundManager()
