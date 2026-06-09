/**
 * WorktreeManager — git worktree 生命周期管理
 * 职责：创建/退出/keep/stale清理
 */

import fs from 'fs'
import path from 'path'
import { execSync, spawnSync } from 'child_process'

export interface WorktreeState {
  active: boolean
  originalCwd: string
  worktreePath: string
  worktreeName: string
  branch: string
  headCommit: string
  createdAt: string
}

export interface CreateResult {
  success: boolean; path: string; name: string; branch: string
  resumed?: boolean; error?: string
}

export interface ExitResult {
  removed: boolean; hasChanges: boolean; changes: string[]
  newCommits: number; restoredCwd: string; error?: string
}

const VALID_NAME_SEGMENT = /^[a-zA-Z0-9._-]+$/
const MAX_NAME_LENGTH = 64
const STALE_DAYS = 30
const SYMLINK_DIRS = ['node_modules']

/** git ref 安全校验 */
const SAFE_REF = /^[a-zA-Z0-9._/\-]+$/

function getStateDir(): string {
  try {
    const gitDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim()
    return path.join(path.resolve(gitDir, '..'), '.myagent', 'worktree')
  } catch {
    return path.join(process.cwd(), '.myagent', 'worktree')
  }
}

function getStateFile(): string { return path.join(getStateDir(), 'state.json') }
function getWorktreesDir(): string { return path.join(path.dirname(getStateDir()), 'worktrees') }

export function validateWorktreeName(name: string): void {
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Invalid worktree name: must be ${MAX_NAME_LENGTH} chars or fewer (got ${name.length})`)
  for (const seg of name.split('/')) {
    if (seg === '.' || seg === '..') throw new Error(`Invalid worktree name "${name}": must not contain "." or ".."`)
    if (!VALID_NAME_SEGMENT.test(seg)) throw new Error(`Invalid worktree name "${name}": each segment must be [a-zA-Z0-9._-]+`)
  }
}

function ensureStateDir(): void { const d = getStateDir(); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) }

function randomName(): string {
  const a = ['swift', 'bright', 'calm', 'keen', 'bold', 'sharp', 'quick', 'warm', 'cool', 'neat']
  const n = ['hawk', 'fox', 'owl', 'wolf', 'bear', 'deer', 'pike', 'lynx', 'dove', 'wren']
  return `${a[Math.floor(Math.random()*a.length)]}-${n[Math.floor(Math.random()*n.length)]}-${Math.floor(Math.random()*1000)}`
}

function getCurrentBranch(): string { try { return execSync('git branch --show-current', { encoding: 'utf-8' }).trim() } catch { return 'main' } }
function dirExists(p: string): boolean { try { return fs.statSync(p).isDirectory() } catch { return false } }

function getRepoRoot(fallback: string): string {
  try { return path.resolve(execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim(), '..') } catch { return fallback }
}

function getHeadCommit(wtPath: string): string {
  try { return execSync('git rev-parse HEAD', { cwd: wtPath, encoding: 'utf-8' }).trim() } catch { return '' }
}

function getBranchAt(wtPath: string): string {
  try { return execSync('git branch --show-current', { cwd: wtPath, encoding: 'utf-8' }).trim() } catch { return getCurrentBranch() }
}

export class WorktreeManager {
  private static instance: WorktreeManager
  static getInstance(): WorktreeManager {
    if (!WorktreeManager.instance) WorktreeManager.instance = new WorktreeManager()
    return WorktreeManager.instance
  }

  // ── Shared helpers ─────────────────────────────────────────────────────

  /** 为 worktree 设置 symlink + exclude。幂等，可重复调用。 */
  private setupSymlinks(repoRoot: string, worktreePath: string): void {
    let cgd = ''; try { cgd = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8' }).trim() } catch { /* ignore */ }
    const ef = cgd ? path.join(cgd, 'info', 'exclude') : ''
    for (const dir of SYMLINK_DIRS) {
      const src = path.join(repoRoot, dir), dest = path.join(worktreePath, dir)
      if (dirExists(src) && !dirExists(dest)) {
        fs.symlinkSync(src, dest, 'dir')
        if (ef) try {
          const existing = fs.existsSync(ef) ? fs.readFileSync(ef, 'utf-8') : ''
          if (!existing.split('\n').some(l => l.trim() === dir)) {
            const id = path.join(cgd, 'info'); if (!fs.existsSync(id)) fs.mkdirSync(id, { recursive: true })
            fs.appendFileSync(ef, `\n# myagent worktree symlink\n${dir}\n`)
          }
        } catch { /* ignore */ }
      }
    }
  }

  loadState(): WorktreeState | null {
    try {
      const f = getStateFile()
      if (!fs.existsSync(f)) return null
      const raw = JSON.parse(fs.readFileSync(f, 'utf-8'))
      // 防篡改：state.json 可能被手动修改，校验关键字段
      if (typeof raw.worktreePath !== 'string' || !raw.worktreePath.includes('.myagent/worktrees/')) return null
      if (typeof raw.branch !== 'string' || raw.branch.length > 128) return null
      // 防 stale：worktree 目录已被手动删除但 state.json 残留
      if (!dirExists(raw.worktreePath)) { this.clearState(); return null }
      return raw
    } catch { return null }
  }
  saveState(s: WorktreeState): void { ensureStateDir(); fs.writeFileSync(getStateFile(), JSON.stringify(s, null, 2)) }
  clearState(): void { try { fs.unlinkSync(getStateFile()) } catch { /* ignore */ } }
  isActive(): boolean { return this.loadState()?.active === true }

  create(worktreeName?: string, baseBranch?: string): CreateResult {
    if (this.isActive()) {
      const st = this.loadState()!
      return { success: false, path: st.worktreePath, name: st.worktreeName, branch: st.branch, error: `Already in worktree: "${st.worktreeName}". Exit it first.` }
    }
    const originalCwd = process.cwd()
    const name = worktreeName || randomName()
    try { validateWorktreeName(name) } catch (e: unknown) { return { success: false, path: '', name, branch: '', error: (e as Error).message } }

    // 安全校验 baseBranch
    if (baseBranch && !SAFE_REF.test(baseBranch)) {
      return { success: false, path: '', name, branch: '', error: `Invalid baseBranch: "${baseBranch}" contains unsafe characters` }
    }

    const repoRoot = getRepoRoot(originalCwd)
    const worktreesDir = path.join(repoRoot, '.myagent', 'worktrees')
    const worktreePath = path.join(worktreesDir, name)

    try {
      // #4: resume — 复用已存在的 worktree
      if (dirExists(worktreePath)) {
        const headCommit = getHeadCommit(worktreePath)
        if (!headCommit) return { success: false, path: worktreePath, name, branch: '', error: 'Worktree exists but has no HEAD' }
        this.setupSymlinks(repoRoot, worktreePath)
        const actualBranch = getBranchAt(worktreePath)
        const st: WorktreeState = { active: true, originalCwd, worktreePath, worktreeName: name, branch: actualBranch, headCommit, createdAt: new Date().toISOString() }
        this.saveState(st); process.chdir(worktreePath)
        return { success: true, path: worktreePath, name, branch: actualBranch, resumed: true }
      }

      if (!dirExists(worktreesDir)) fs.mkdirSync(worktreesDir, { recursive: true })
      const branchName = `feature/${name}`
      execSync(`git worktree add "${worktreePath}" -b "${branchName}" "${baseBranch || 'HEAD'}"`, { stdio: 'pipe', encoding: 'utf-8' })

      const headCommit = getHeadCommit(worktreePath)
      this.setupSymlinks(repoRoot, worktreePath)

      const state: WorktreeState = { active: true, originalCwd, worktreePath, worktreeName: name, branch: branchName, headCommit, createdAt: new Date().toISOString() }
      this.saveState(state); process.chdir(worktreePath)
      return { success: true, path: worktreePath, name, branch: branchName }
    } catch (err: unknown) { const m = err instanceof Error ? err.message : String(err); return { success: false, path: worktreePath, name, branch: '', error: m } }
  }

  exit(force = false): ExitResult {
    const state = this.loadState()
    if (!state?.active) return { removed: false, hasChanges: false, changes: [], newCommits: 0, restoredCwd: process.cwd(), error: 'No active worktree.' }
    const oc = state.originalCwd
    try {
      let changes: string[] = []
      let gitStatusFailed = false
      try { changes = (execSync('git status --porcelain', { cwd: state.worktreePath, encoding: 'utf-8' }).trim() || '').split('\n').filter(Boolean) }
      catch { gitStatusFailed = true }

      let nc = 0
      let revListFailed = false
      if (state.headCommit) try { nc = parseInt(execSync(`git rev-list --count ${state.headCommit}..HEAD`, { cwd: state.worktreePath, encoding: 'utf-8' }).trim(), 10) || 0 }
      catch { revListFailed = true }

      // 两个 git 命令都失败 → 保守假定有改动，拒绝删除
      if (gitStatusFailed && revListFailed) {
        return { removed: false, hasChanges: true, changes: [], newCommits: 0, restoredCwd: oc, error: 'Cannot verify worktree state: git commands failed. Try force=true if you are sure.' }
      }
      const dirty = changes.length > 0 || nc > 0
      if (dirty && !force) return { removed: false, hasChanges: true, changes, newCommits: nc, restoredCwd: oc }
      try { execSync(`git worktree remove "${state.worktreePath}"${force ? ' --force' : ''}`, { stdio: 'pipe', encoding: 'utf-8' }) }
      catch (e: unknown) { return { removed: false, hasChanges: dirty, changes, newCommits: nc, restoredCwd: oc, error: `git worktree remove failed: ${e instanceof Error ? e.message : String(e)}` } }
      process.chdir(oc)
      try { fs.rmSync(state.worktreePath, { recursive: true, force: true }) } catch { /* ignore */ }
      try { if (fs.readdirSync(path.dirname(state.worktreePath)).length === 0) fs.rmdirSync(path.dirname(state.worktreePath)) } catch { /* ignore */ }
      // 删除 agent 创建的 feature 分支（避免分支泄漏）
      if (state.branch && state.branch.startsWith('feature/')) {
        try { execSync(`git branch -D "${state.branch}"`, { stdio: 'pipe' }) } catch { /* ignore */ }
      }
      this.clearState()
      return { removed: true, hasChanges: dirty, changes, newCommits: nc, restoredCwd: oc }
    } catch (e: unknown) { try { process.chdir(oc) } catch { /* ignore */ }; return { removed: false, hasChanges: false, changes: [], newCommits: 0, restoredCwd: oc, error: e instanceof Error ? e.message : String(e) } }
  }

  // #2: keep
  keep(): { success: boolean; worktreePath: string; restoredCwd: string; error?: string } {
    const s = this.loadState()
    if (!s?.active) return { success: false, worktreePath: '', restoredCwd: process.cwd(), error: 'No active worktree.' }
    try { process.chdir(s.originalCwd); const wp = s.worktreePath; this.clearState(); return { success: true, worktreePath: wp, restoredCwd: s.originalCwd } }
    catch (e: unknown) { return { success: false, worktreePath: s.worktreePath, restoredCwd: s.originalCwd, error: e instanceof Error ? e.message : String(e) } }
  }

  checkChanges(): { hasChanges: boolean; changes: string[]; newCommits: number } {
    const s = this.loadState(); if (!s?.active) return { hasChanges: false, changes: [], newCommits: 0 }
    let ch: string[] = []; try { ch = (execSync('git status --porcelain', { cwd: s.worktreePath, encoding: 'utf-8' }).trim() || '').split('\n').filter(Boolean) } catch { /* ignore */ }
    let nc = 0; if (s.headCommit) try { nc = parseInt(execSync(`git rev-list --count ${s.headCommit}..HEAD`, { cwd: s.worktreePath, encoding: 'utf-8' }).trim(), 10) || 0 } catch { /* ignore */ }
    return { hasChanges: ch.length > 0 || nc > 0, changes: ch, newCommits: nc }
  }

  getStatus(): WorktreeState | null { const s = this.loadState(); return s?.active ? s : null }

  // #5: stale cleanup
  cleanupStaleWorktrees(): number {
    const wd = getWorktreesDir(); if (!dirExists(wd)) return 0
    const cutoff = Date.now() - STALE_DAYS * 86400000
    const cp = this.loadState()?.worktreePath
    let rm = 0; let ents: string[]; try { ents = fs.readdirSync(wd) } catch { return 0 }
    for (const n of ents) {
      const wp = path.join(wd, n); if (wp === cp) continue
      let mt: number; try { mt = fs.statSync(wp).mtimeMs } catch { continue }
      if (mt >= cutoff) continue
      try { if (!fs.readFileSync(path.join(wp, '.git'), 'utf-8').startsWith('gitdir:')) continue } catch { continue }
      try { execSync(`git worktree remove --force "${wp}"`, { stdio: 'pipe', encoding: 'utf-8' }); try { fs.rmSync(wp, { recursive: true, force: true }) } catch { /* ignore */ }; rm++ } catch { /* ignore */ }
    }
    if (rm > 0) try { execSync('git worktree prune', { stdio: 'pipe' }) } catch { /* ignore */ }
    return rm
  }

  // ── Sub-agent worktree ─────────────────────────────────────────────────

  /** 为 sub-agent 创建隔离 worktree。不改变全局 cwd，返回 path + branch。 */
  createSubAgentWorktree(name?: string): { success: boolean; path: string; branch: string; error?: string } {
    const n = name || randomName()
    try { validateWorktreeName(n) } catch (e: unknown) { return { success: false, path: '', branch: '', error: (e as Error).message } }
    const repoRoot = getRepoRoot(process.cwd())
    const worktreesDir = path.join(repoRoot, '.myagent', 'worktrees')
    const worktreePath = path.join(worktreesDir, n)

    try {
      // resume if exists
      if (dirExists(worktreePath)) {
        this.setupSymlinks(repoRoot, worktreePath)
        const actualBranch = getBranchAt(worktreePath)
        return { success: true, path: worktreePath, branch: actualBranch }
      }
      if (!dirExists(worktreesDir)) fs.mkdirSync(worktreesDir, { recursive: true })
      const branchName = `feature/${n}`
      execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, { stdio: 'pipe', encoding: 'utf-8' })
      this.setupSymlinks(repoRoot, worktreePath)
      return { success: true, path: worktreePath, branch: branchName }
    } catch (e: unknown) { return { success: false, path: worktreePath, branch: '', error: e instanceof Error ? e.message : String(e) } }
  }

  /** 删除 sub-agent worktree。 */
  removeSubAgentWorktree(worktreePath: string, branch?: string): boolean {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, { stdio: 'pipe', encoding: 'utf-8' })
      try { fs.rmSync(worktreePath, { recursive: true, force: true }) } catch { /* ignore */ }
      if (branch) try { execSync(`git branch -D "${branch}"`, { stdio: 'pipe' }) } catch { /* ignore */ }
      return true
    } catch { return false }
  }
}
