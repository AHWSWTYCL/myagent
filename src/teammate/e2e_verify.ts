/**
 * e2e_verify.ts — 端到端验证独立进程 teammate。
 *
 * 流程：
 *   1. 通过 child_process 启动 teammate CLI
 *   2. 等待 teammate 启动（检查 PID 文件）
 *   3. leader 发送 task 邮件
 *   4. 等待 teammate 返回 result 邮件
 *   5. leader 发送 close 邮件
 *   6. 等待 teammate 退出
 *   7. 验证各步骤结果
 */

import * as cp from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Mailbox } from '../mailbox/mailbox.js'
import { formatMail } from '../mailbox/mailbox.js'

const LEADER_ID = 'main'
const TEAMMATE_ID = 'e2e-test-wk'
const RUNTIME_DIR = path.join(os.homedir(), '.myagent', 'runtime', 'teammates')
const PID_FILE = path.join(RUNTIME_DIR, `${TEAMMATE_ID}.json`)

let testsPassed = 0
let testsFailed = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
    testsPassed++
  } else {
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
    testsFailed++
  }
}

// ── 清理 ──────────────────────────────────────────────────────────────
function cleanup(): void {
  // 清理 mailbox
  Mailbox.destroy(TEAMMATE_ID)
  // 清理 PID 文件
  try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ }
}

cleanup()

async function main(): Promise<void> {
  console.log(`\n╔══════════════════════════════════════════════╗`)
  console.log(`║  E2E: 独立进程 teammate 端到端验证           ║`)
  console.log(`╚══════════════════════════════════════════════╝\n`)

  // ── 1. 启动 teammate 进程 ────────────────────────────────────────
  console.log('📦 Step 1: 启动 teammate 进程...')

  const cwd = process.cwd()
  const cmd = `cd "${cwd}" && npx tsx src/agent.ts teammate --id "${TEAMMATE_ID}" --leader "${LEADER_ID}" --role "e2e tester" --tools "read_file,write_file,bash"`

  const child = cp.spawn('bash', ['-c', cmd], {
    detached: true,
    stdio: 'ignore', // teammate 输出到 stderr，我们不关心
    cwd: process.cwd(),
  })

  child.unref()

  // 等待 PID 文件出现（teammate 启动标志）
  let pidFileAppeared = false
  for (let i = 0; i < 15; i++) {
    await sleep(1000)
    if (fs.existsSync(PID_FILE)) {
      pidFileAppeared = true
      const raw = fs.readFileSync(PID_FILE, 'utf-8')
      const spec = JSON.parse(raw)
      console.log(`  teammate pid: ${spec.pid}, status: ${spec.status}`)
      break
    }
    console.log(`  waiting for PID file... (${i + 1}s)`)
  }
  check('PID file created', pidFileAppeared)
  if (!pidFileAppeared) {
    console.log('  ❌ Teammate failed to start within 15s')
    process.exit(1)
  }

  // 多等一秒确保 mailbox watcher 就绪
  await sleep(1000)

  // ── 2. 发送 task 邮件 ────────────────────────────────────────────
  console.log('\n📧 Step 2: 发送 task 邮件...')

  Mailbox.startWatching(LEADER_ID)

  const taskMail = Mailbox.send({
    from: LEADER_ID,
    to: TEAMMATE_ID,
    kind: 'task',
    subject: 'E2E: simple task',
    body: '请用 read_file 读取 src/hello.ts，然后用 send_mail (kind=result) 返回文件内容的前 200 个字符。',
  })
  console.log(`  task mail sent: ${taskMail.id}`)
  check('task mail sent', !!taskMail.id)

  // ── 3. 等待 result 邮件 ──────────────────────────────────────────
  console.log('\n📬 Step 3: 等待 result 邮件...')

  let resultReceived = false
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    // 检查主 agent 邮箱
    const mails = Mailbox.list(LEADER_ID)
    const resultMail = mails.find(m => m.kind === 'result' && m.from === TEAMMATE_ID)
    if (resultMail) {
      resultReceived = true
      console.log(`  result received:`)
      console.log(`    from: ${resultMail.from}`)
      console.log(`    subject: ${resultMail.subject}`)
      console.log(`    body (first 150 chars): ${resultMail.body.slice(0, 150)}...`)
      // 消费
      Mailbox.markRead(LEADER_ID, resultMail.id)
      break
    }
    // 也检查 status 邮件
    const statusMails = mails.filter(m => m.kind === 'status' && m.from === TEAMMATE_ID)
    if (statusMails.length > 0) {
      console.log(`  status update: ${statusMails[statusMails.length - 1].subject}`)
      for (const m of statusMails) Mailbox.markRead(LEADER_ID, m.id)
    }
  }
  check('result mail received', resultReceived)

  // ── 4. 发送 close 邮件 ───────────────────────────────────────────
  console.log('\n🔒 Step 4: 发送 close 邮件...')

  const closeMail = Mailbox.send({
    from: LEADER_ID,
    to: TEAMMATE_ID,
    kind: 'close',
    subject: 'E2E done',
    body: '验证完成，请退出。',
  })
  console.log(`  close mail sent: ${closeMail.id}`)
  check('close mail sent', !!closeMail.id)

  // ── 5. 等待 teammate 退出 ───────────────────────────────────────
  console.log('\n⏳ Step 5: 等待 teammate 退出...')

  let teammateExited = false
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    if (!fs.existsSync(PID_FILE)) {
      teammateExited = true
      console.log(`  PID file removed → teammate exited`)
      break
    }
    // 检查 heartbeat 是否停止
    try {
      const raw = fs.readFileSync(PID_FILE, 'utf-8')
      const spec = JSON.parse(raw)
      const lastBeat = new Date(spec.heartbeat_at).getTime()
      const now = Date.now()
      if (now - lastBeat > 8000) {
        teammateExited = true
        console.log(`  heartbeat stale (${Math.round((now - lastBeat) / 1000)}s ago) → teammate likely exited`)
        break
      }
    } catch { /* ignore */ }
  }
  check('teammate exited', teammateExited)

  // ── 总结 ─────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`  Results: ${testsPassed} passed, ${testsFailed} failed`)
  console.log(`${'═'.repeat(50)}\n`)

  // 清理
  cleanup()
  Mailbox.stopWatching(LEADER_ID)

  process.exit(testsFailed > 0 ? 1 : 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main().catch(err => {
  console.error('E2E test crashed:', err)
  cleanup()
  process.exit(1)
})
