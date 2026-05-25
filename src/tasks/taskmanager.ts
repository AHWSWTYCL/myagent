/**
 * TaskManager — 基于文档的任务管理器
 *
 * 职责：
 *   - 在 ~/.myagent/tasks/ 下以 .md 文件存储每个任务
 *   - 提供 CRUD 操作
 *   - 自动维护依赖传播（done → 解锁依赖者）
 *   - 维护 INDEX.md 总览
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { Task, TaskStatus, TASK_STATUSES, STATUS_ICON, STATUS_ORDER } from './task.js'

/** 任务文件存储根目录 */
const TASKS_BASE_DIR = path.join(os.homedir(), '.myagent', 'tasks')

// ============================================================
//  Frontmatter 解析（轻量，不依赖 yaml 库）
// ============================================================

function serializeFrontmatter(task: Task): string {
  const lines = [
    '---',
    `id: "${task.id}"`,
    `status: "${task.status}"`,
    `subagent_id: "${task.subagent_id}"`,
    `depends_on: [${task.depends_on.map(d => `"${d}"`).join(', ')}]`,
    `depended_by: [${task.depended_by.map(d => `"${d}"`).join(', ')}]`,
    `title: "${escapeYamlValue(task.title)}"`,
    `revision_count: ${task.revision_count}`,
    `created_at: "${task.created_at}"`,
    `updated_at: "${task.updated_at}"`,
    '---',
  ]
  return lines.join('\n')
}

function escapeYamlValue(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function unescapeYamlValue(val: string): string {
  return val.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

interface ParsedFrontmatter {
  data: Record<string, any>
  body: string
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    throw new Error('无法解析 frontmatter')
  }
  const raw = match[1]
  const body = match[2].trim()

  const data: Record<string, any> = {}
  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (!key) continue

    const clean = value.replace(/^"(.*)"$/, '$1')

    // 解析数组格式: ["a", "b"]
    if (clean.startsWith('[') && clean.endsWith(']')) {
      const inner = clean.slice(1, -1).trim()
      data[key] = inner
        ? inner.split(',').map(s => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
        : []
    } else {
      data[key] = unescapeYamlValue(clean)
    }
  }
  return { data, body }
}

function taskToFile(task: Task): string {
  const frontmatter = serializeFrontmatter(task)
  return `${frontmatter}\n\n${task.description || '(暂无详细描述)'}\n`
}

function fileToTask(content: string): Task {
  const { data, body } = parseFrontmatter(content)

  const status = data.status
  if (!TASK_STATUSES.includes(status)) {
    throw new Error(`非法任务状态: ${status}`)
  }

  return {
    id: data.id || '',
    status: status as TaskStatus,
    subagent_id: data.subagent_id || '',
    depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
    depended_by: Array.isArray(data.depended_by) ? data.depended_by : [],
    title: data.title || '(无标题)',
    description: body,
    revision_count: data.revision_count !== undefined ? Number(data.revision_count) || 0 : 0,
    created_at: data.created_at || '',
    updated_at: data.updated_at || '',
  }
}

// ============================================================
//  TaskManager
// ============================================================

export class TaskManager {
  private readonly tasksDir: string

  constructor(namespace?: string) {
    this.tasksDir = namespace
      ? path.join(TASKS_BASE_DIR, namespace)
      : TASKS_BASE_DIR
    this.ensureDir()
  }

  // ── 目录维护 ──

  private ensureDir(): void {
    fs.mkdirSync(this.tasksDir, { recursive: true })
  }

  private taskPath(id: string): string {
    return path.join(this.tasksDir, `${id}.md`)
  }

  private indexPath(): string {
    return path.join(this.tasksDir, 'INDEX.md')
  }

  // ── 生成唯一 ID ──

  private generateId(): string {
    const short = crypto.randomUUID().slice(0, 8)
    return `task-${short}`
  }

  // ── 内部读写 ──

  private readTaskFile(id: string): Task | null {
    const filePath = this.taskPath(id)
    if (!fs.existsSync(filePath)) return null
    const content = fs.readFileSync(filePath, 'utf-8')
    try {
      return fileToTask(content)
    } catch {
      return null
    }
  }

  private writeTaskFile(task: Task): void {
    const content = taskToFile(task)
    fs.writeFileSync(this.taskPath(task.id), content, 'utf-8')
  }

  private deleteTaskFile(id: string): boolean {
    const filePath = this.taskPath(id)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    return true
  }

  private listAllTaskIds(): string[] {
    this.ensureDir()
    return fs
      .readdirSync(this.tasksDir)
      .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
      .map(f => f.replace(/\.md$/, ''))
  }

  // ── 依赖传播 ──

  /**
   * 计算一个任务基于其依赖关系的"正确状态"。
   * 规则：
   *   - 如果状态是 done / cancelled，保持不变（用户手动设置的终态）
   *   - 如果有未完成的 depends_on，且当前是 todo，则置为 blocked
   *   - 如果所有 depends_on 都完成（done），且当前是 blocked，则置为 todo
   */
  private resolveStatus(task: Task): TaskStatus {
    // 终态不自动改变
    if (task.status === 'done' || task.status === 'cancelled') {
      return task.status
    }

    if (task.depends_on.length === 0) {
      // 没有依赖，不可能 blocked
      if (task.status === 'blocked') return 'todo'
      return task.status
    }

    // 检查所有依赖是否都完成
    const allDone = task.depends_on.every(depId => {
      const dep = this.readTaskFile(depId)
      return dep && dep.status === 'done'
    })

    if (allDone) {
      // 所有依赖已完成 → 解锁
      if (task.status === 'blocked') return 'todo'
      return task.status
    } else {
      // 存在未完成的依赖 → 阻塞
      if (task.status === 'todo' || task.status === 'in_progress') return 'blocked'
      return task.status
    }
  }

  /**
   * 依赖传播：从某个任务出发，更新所有依赖它的任务的状态。
   * 在任务变为 done 时调用。
   */
  private propagateFrom(taskId: string): void {
    const task = this.readTaskFile(taskId)
    if (!task) return

    // 找到所有 depended_by 的任务（即依赖当前任务的其他任务）
    for (const dependentId of task.depended_by) {
      const dependent = this.readTaskFile(dependentId)
      if (!dependent) continue

      const oldStatus = dependent.status
      const newStatus = this.resolveStatus(dependent)
      if (newStatus !== oldStatus) {
        dependent.status = newStatus
        dependent.updated_at = new Date().toISOString()
        this.writeTaskFile(dependent)
        console.log(`  [依赖传播] ${dependent.id}: ${oldStatus} → ${newStatus}`)
        // 递归传播
        this.propagateFrom(dependent.id)
      }
    }
  }

  // ============================================================
  //  公开 API
  // ============================================================

  /** 创建任务 */
  create(data: {
    title: string
    description?: string
    depends_on?: string[]
    subagent_id?: string
  }): Task {
    const id = this.generateId()
    const now = new Date().toISOString()

    const dependsOn = data.depends_on ?? []

    // 验证依赖是否存在
    for (const depId of dependsOn) {
      if (!this.readTaskFile(depId)) {
        throw new Error(`依赖任务 ${depId} 不存在`)
      }
    }

    // 初始状态：有未完成的依赖则 blocked，否则 todo
    const allDepsDone = dependsOn.every(depId => {
      const dep = this.readTaskFile(depId)
      return dep && dep.status === 'done'
    })
    const status: TaskStatus = dependsOn.length === 0 || allDepsDone ? 'todo' : 'blocked'

    const task: Task = {
      id,
      status,
      subagent_id: data.subagent_id ?? '',
      depends_on: dependsOn,
      depended_by: [],
      title: data.title,
      description: data.description ?? '',
      revision_count: 0,
      created_at: now,
      updated_at: now,
    }

    // 在依赖任务中注册 depended_by
    for (const depId of task.depends_on) {
      const dep = this.readTaskFile(depId)
      if (dep) {
        if (!dep.depended_by.includes(task.id)) {
          dep.depended_by.push(task.id)
          dep.updated_at = now
          this.writeTaskFile(dep)
        }
      }
    }

    this.writeTaskFile(task)
    this.rebuildIndex()
    return task
  }

  /** 获取单个任务 */
  get(id: string): Task | null {
    return this.readTaskFile(id)
  }

  /** 列出所有任务，可选过滤 */
  list(filter?: { status?: TaskStatus; depends_on?: string }): Task[] {
    const ids = this.listAllTaskIds()
    let tasks: Task[] = []

    for (const id of ids) {
      const task = this.readTaskFile(id)
      if (task) tasks.push(task)
    }

    if (filter?.status) {
      tasks = tasks.filter(t => t.status === filter.status)
    }
    if (filter?.depends_on) {
      tasks = tasks.filter(t => t.depends_on.includes(filter.depends_on!))
    }

    // 按状态优先级升序，同状态内按创建时间升序
    tasks.sort((a, b) => {
      const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      if (statusDiff !== 0) return statusDiff
      return a.created_at.localeCompare(b.created_at)
    })
    return tasks
  }

  /**
   * 更新任务的部分字段。
   * 关键逻辑：如果 status 变为 done，触发依赖传播。
   */
  update(
    id: string,
    data: Partial<{
      status: TaskStatus
      subagent_id: string
      title: string
      description: string
      depends_on: string[]
      revision_count: number
    }>,
  ): Task | null {
    const task = this.readTaskFile(id)
    if (!task) return null

    const now = new Date().toISOString()

    if (data.status !== undefined) {
      if (!TASK_STATUSES.includes(data.status)) {
        throw new Error(`非法状态: ${data.status}`)
      }
      task.status = data.status
    }

    if (data.subagent_id !== undefined) task.subagent_id = data.subagent_id
    if (data.title !== undefined) task.title = data.title
    if (data.description !== undefined) task.description = data.description
    if (data.revision_count !== undefined) task.revision_count = data.revision_count

    if (data.depends_on !== undefined) {
      // 从旧的依赖中移除当前任务的 depended_by
      for (const oldDepId of task.depends_on) {
        const oldDep = this.readTaskFile(oldDepId)
        if (oldDep) {
          oldDep.depended_by = oldDep.depended_by.filter(d => d !== task.id)
          oldDep.updated_at = now
          this.writeTaskFile(oldDep)
        }
      }

      // 验证新依赖是否存在
      for (const newDepId of data.depends_on) {
        if (!this.readTaskFile(newDepId)) {
          throw new Error(`依赖任务 ${newDepId} 不存在`)
        }
      }

      task.depends_on = data.depends_on

      // 在新依赖中注册 depended_by
      for (const newDepId of task.depends_on) {
        const newDep = this.readTaskFile(newDepId)
        if (newDep) {
          if (!newDep.depended_by.includes(task.id)) {
            newDep.depended_by.push(task.id)
            newDep.updated_at = now
            this.writeTaskFile(newDep)
          }
        }
      }

      // 重新计算状态
      const resolved = this.resolveStatus(task)
      if (resolved !== task.status) {
        task.status = resolved
      }
    }

    task.updated_at = now
    this.writeTaskFile(task)

    // 如果状态变为 done，触发依赖传播
    if (data.status === 'done') {
      this.propagateFrom(task.id)
    }

    this.rebuildIndex()
    return task
  }

  /** 删除任务 */
  delete(id: string): boolean {
    const task = this.readTaskFile(id)
    if (!task) return false

    const now = new Date().toISOString()

    // 从依赖中移除当前任务的 depended_by
    for (const depId of task.depends_on) {
      const dep = this.readTaskFile(depId)
      if (dep) {
        dep.depended_by = dep.depended_by.filter(d => d !== id)
        dep.updated_at = now
        this.writeTaskFile(dep)
      }
    }

    // 清理依赖当前任务的任务：移除悬空引用并重新计算状态
    for (const dependentId of task.depended_by) {
      const dependent = this.readTaskFile(dependentId)
      if (!dependent) continue
      dependent.depends_on = dependent.depends_on.filter(d => d !== id)
      dependent.status = this.resolveStatus(dependent)
      dependent.updated_at = now
      this.writeTaskFile(dependent)
    }

    const deleted = this.deleteTaskFile(id)
    if (deleted) this.rebuildIndex()
    return deleted
  }

  /**
   * 删除整个任务目录（仅对有 namespace 的实例有意义）。
   * 用于 coordinator 收尾时一次性清理本次 pipeline 的所有任务文件。
   */
  destroy(): void {
    fs.rmSync(this.tasksDir, { recursive: true, force: true })
  }

  /** 重建 INDEX.md */
  rebuildIndex(): void {
    const tasks = this.list()
    const lines: string[] = [
      '# 任务索引',
      `最后更新: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      '',
      `共 ${tasks.length} 个任务`,
      '',
      '| ID | 状态 | 标题 | 依赖 | SubAgent |',
      '|----|------|------|------|----------|',
    ]

    for (const task of tasks) {
      const icon = STATUS_ICON[task.status]
      const deps = task.depends_on.length > 0 ? task.depends_on.join(', ') : '-'
      const agent = task.subagent_id || '-'
      lines.push(`| ${task.id} | ${icon} ${task.status} | ${task.title} | ${deps} | ${agent} |`)
    }

    fs.writeFileSync(this.indexPath(), lines.join('\n') + '\n', 'utf-8')
  }

  /**
   * 获取一个任务的依赖图（前驱和后继），用于可视化。
   */
  graph(id: string): { task: Task | null; dependents: Task[]; dependencies: Task[] } {
    const task = this.readTaskFile(id)
    if (!task) return { task: null, dependents: [], dependencies: [] }

    const dependents = task.depended_by
      .map(did => this.readTaskFile(did))
      .filter((t): t is Task => t !== null)

    const dependencies = task.depends_on
      .map(did => this.readTaskFile(did))
      .filter((t): t is Task => t !== null)

    return { task, dependents, dependencies }
  }
}

// ============================================================
//  格式化工具函数（供 TaskTool 和 TaskCommand 共用）
// ============================================================

/** 单行摘要，用于 list 输出 */
export function formatTaskLine(task: Task): string {
  const depInfo = task.depends_on.length > 0 ? ` [依赖: ${task.depends_on.join(', ')}]` : ''
  const agentInfo = task.subagent_id ? ` [agent: ${task.subagent_id}]` : ''
  return `  ${STATUS_ICON[task.status]} ${task.id} — ${task.title}${depInfo}${agentInfo}`
}

/** 详情视图，用于 get/show 输出 */
export function formatTaskDetail(task: Task): string {
  const lines: string[] = [
    `📋 任务: ${task.id}`,
    `  标题: ${task.title}`,
    `  状态: ${STATUS_ICON[task.status]} ${task.status}`,
    `  SubAgent: ${task.subagent_id || '(未分配)'}`,
    `  创建时间: ${task.created_at.slice(0, 16).replace('T', ' ')}`,
    `  更新时间: ${task.updated_at.slice(0, 16).replace('T', ' ')}`,
    `  前置依赖: ${task.depends_on.length > 0 ? task.depends_on.join(', ') : '(无)'}`,
    `  被依赖: ${task.depended_by.length > 0 ? task.depended_by.join(', ') : '(无)'}`,
  ]
  if (task.description) {
    lines.push(`\n  描述:\n${task.description.split('\n').map(l => `    ${l}`).join('\n')}`)
  }
  return lines.join('\n')
}
