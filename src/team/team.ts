/**
 * TeamManager — 文件式 team 管理器。
 *
 * 设计要点：
 *   - 每个 team 一个目录 `~/.myagent/teams/<team_name>/`
 *   - 元信息文件 `team.json`（name, leader_id, members, created_at, description）
 *   - 读写都是单文件原子操作，跨进程安全
 *   - 仿 mailbox.ts 文件式模式，不引入新抽象
 *
 * Team 是对 leader + N teammates 协作组的形式化：
 *   - "房间"隐喻：创建 team 就是给协作组一个命名空间
 *   - teammate spawn 时可选择加入指定 team，自动登记成员
 *   - 可通过 team 查成员列表、清理资源
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export interface TeamMember {
  agent_id: string
  role?: string
  joined_at: string
}

export interface TeamManifest {
  name: string
  created_at: string
  description: string
  leader_id?: string
  members: TeamMember[]
}

const TEAMS_BASE = path.join(os.homedir(), '.myagent', 'teams')

function teamDir(teamName: string): string {
  return path.join(TEAMS_BASE, sanitize(teamName))
}

function teamFile(teamName: string): string {
  return path.join(teamDir(teamName), 'team.json')
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-.]/g, '_')
}

function ensureDir(teamName: string): void {
  fs.mkdirSync(teamDir(teamName), { recursive: true })
}

function readManifest(teamName: string): TeamManifest | null {
  const file = teamFile(teamName)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as TeamManifest
  } catch {
    return null
  }
}

function writeManifest(teamName: string, manifest: TeamManifest): void {
  ensureDir(teamName)
  fs.writeFileSync(teamFile(teamName), JSON.stringify(manifest, null, 2), 'utf-8')
}

export class TeamManager {
  /** 创建一个 team。返回 manifest。 */
  static create(opts: {
    name: string
    leader_id?: string
    description?: string
  }): TeamManifest {
    ensureDir(opts.name)
    const manifest: TeamManifest = {
      name: opts.name,
      created_at: new Date().toISOString(),
      description: opts.description ?? '',
      leader_id: opts.leader_id,
      members: [],
    }
    writeManifest(opts.name, manifest)
    return manifest
  }

  /** 检查 team 是否存在。 */
  static exists(teamName: string): boolean {
    return fs.existsSync(teamFile(teamName))
  }

  /** 获取 team manifest，不存在返回 null。 */
  static get(teamName: string): TeamManifest | null {
    return readManifest(teamName)
  }

  /** 列出所有 team 名称。 */
  static list(): string[] {
    if (!fs.existsSync(TEAMS_BASE)) return []
    return fs.readdirSync(TEAMS_BASE, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  }

  /** 向 team 添加成员。如果已有同名 agent_id 则覆盖。 */
  static addMember(teamName: string, agentId: string, role?: string): TeamManifest | null {
    const m = readManifest(teamName)
    if (!m) return null
    // 移除旧记录（如有）
    m.members = m.members.filter(mb => mb.agent_id !== agentId)
    m.members.push({
      agent_id: agentId,
      role,
      joined_at: new Date().toISOString(),
    })
    writeManifest(teamName, m)
    return m
  }

  /** 从 team 移除成员。 */
  static removeMember(teamName: string, agentId: string): boolean {
    const m = readManifest(teamName)
    if (!m) return false
    const before = m.members.length
    m.members = m.members.filter(mb => mb.agent_id !== agentId)
    if (m.members.length === before) return false
    writeManifest(teamName, m)
    return true
  }

  /** 获取 team 成员列表。 */
  static listMembers(teamName: string): TeamMember[] {
    const m = readManifest(teamName)
    if (!m) return []
    return [...m.members]
  }

  /** 获取 team 所有成员的 agent_id 列表。 */
  static getMemberIds(teamName: string): string[] {
    return TeamManager.listMembers(teamName).map(m => m.agent_id)
  }

  /** 解散 team：删除整个 team 目录。 */
  static disband(teamName: string): boolean {
    const dir = teamDir(teamName)
    if (!fs.existsSync(dir)) return false
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  }
}
