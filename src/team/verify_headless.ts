/**
 * 完整的集成验证 — 模拟 headless 模式下的 create_team + start_teammate 流程
 * 由于 Node.js v16 不兼容 tsx v4（regex `v` flag），用直接调用替代 agent loop
 */
import { TeamManager } from './team.js'
import { Mailbox } from '../mailbox/mailbox.js'
import * as fs from 'fs'
import * as os from 'os'

const PASS = '✅'
const FAIL = '❌'
let failures = 0

function check(desc: string, cond: boolean) {
  console.log(`${cond ? PASS : FAIL} ${desc}`)
  if (!cond) failures++
}

// ── 测试 1: create_team ──────────────────────────────────────────────
console.log('\n=== 测试 1: create_team（模拟 agent tool 调用） ===')

const manifest = TeamManager.create({
  name: 'headless-sim',
  leader_id: 'main',
  description: 'Simulated headless test'
})
check('manifest.name == "headless-sim"', manifest.name === 'headless-sim')
check('manifest.leader_id == "main"', manifest.leader_id === 'main')
check('manifest.members is empty', manifest.members.length === 0)

// 验证文件存在
const teamPath = os.homedir() + '/.myagent/teams/headless-sim/team.json'
check('team.json 存在', fs.existsSync(teamPath))

const diskContent = JSON.parse(fs.readFileSync(teamPath, 'utf-8'))
check('磁盘文件 name 正确', diskContent.name === 'headless-sim')
check('磁盘文件 description 正确', diskContent.description === 'Simulated headless test')

// ── 测试 2: 重复创建 ──────────────────────────────────────────────
console.log('\n=== 测试 2: 重复创建（幂等，提示已存在） ===')
check('headless-sim exists', TeamManager.exists('headless-sim'))
check('nonexistent not exists', !TeamManager.exists('no-such-team'))

// ── 测试 3: addMember（模拟 start_teammate 注册） ─────────────────
console.log('\n=== 测试 3: addMember（模拟 start_teammate team_name 参数） ===')
TeamManager.addMember('headless-sim', 'wk-gen-1', 'code generator')
TeamManager.addMember('headless-sim', 'wk-ver-1', 'code verifier')

const members = TeamManager.listMembers('headless-sim')
check('成员数 == 2', members.length === 2)
check('wk-gen-1 在列表中', members.some(m => m.agent_id === 'wk-gen-1'))
check('wk-ver-1 在列表中', members.some(m => m.agent_id === 'wk-ver-1'))
check('wk-gen-1 角色正确', members.find(m => m.agent_id === 'wk-gen-1')?.role === 'code generator')

// ── 测试 4: getMemberIds（给 teammate 看队友列表） ─────────────────
console.log('\n=== 测试 4: getMemberIds（teammate 查队友） ===')
const ids = TeamManager.getMemberIds('headless-sim')
check('IDs 包含 wk-gen-1 和 wk-ver-1', ids.includes('wk-gen-1') && ids.includes('wk-ver-1'))
check('ID 数量 == 2', ids.length === 2)

// ── 测试 5: 覆盖重复成员 ───────────────────────────────────────────
console.log('\n=== 测试 5: 覆盖重复成员（幂等注册） ===')
TeamManager.addMember('headless-sim', 'wk-gen-1', 'updated role')
const afterDup = TeamManager.listMembers('headless-sim')
check('成员数仍为 2（无重复）', afterDup.length === 2)
check('角色已更新', afterDup.find(m => m.agent_id === 'wk-gen-1')?.role === 'updated role')

// ── 测试 6: 添加不存在的 team 的成员 ──────────────────────────────
console.log('\n=== 测试 6: 向不存在的 team 添加成员（优雅降级） ===')
const nullResult = TeamManager.addMember('no-such-team', 'wk-x', 'test')
check('返回 null', nullResult === null)

// ── 测试 7: mailbox 仍然正常工作（team 不影响 mailbox） ───────────
console.log('\n=== 测试 7: mailbox 独立工作（team 不影响邮箱） ===')
const mail = Mailbox.send({
  from: 'main',
  to: 'wk-gen-1',
  subject: 'test task',
  kind: 'task',
  body: 'do something'
})
check('邮件发送成功', !!mail.id)
check('邮件 from == main', mail.from === 'main')
check('邮件 to == wk-gen-1', mail.to === 'wk-gen-1')
check('邮件 kind == task', mail.kind === 'task')

// 验证 teammate 可以 pop 邮件
const popped = Mailbox.popFirst('wk-gen-1')
check('teammate 可以 pop 邮件', popped !== null)
check('pop 的邮件 id 正确', popped?.id === mail.id)

// cleanup mailbox
Mailbox.destroy('wk-gen-1')

// ── 测试 8: list teams ─────────────────────────────────────────────
console.log('\n=== 测试 8: list teams ===')
const teams = TeamManager.list()
check('headless-sim 在列表中', teams.includes('headless-sim'))

// ── 测试 9: disband ─────────────────────────────────────────────────
console.log('\n=== 测试 9: disband team ===')
TeamManager.disband('headless-sim')
check('disband 后不存在', !TeamManager.exists('headless-sim'))
check('team.json 已删除', !fs.existsSync(teamPath))

// ── 结果 ────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? PASS : FAIL} ${failures === 0 ? '全部通过！' : `${failures} 项失败`}`)
process.exit(failures > 0 ? 1 : 0)
