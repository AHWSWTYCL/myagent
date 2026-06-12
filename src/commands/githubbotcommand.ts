/**
 * GitHubBotCommand — `/github-bot`
 *
 * 纯 gh CLI 驱动，两步完成：
 *   ① /github-bot app       → 打开浏览器创建 GitHub App → 自动捕获 code → 兑换 + secrets
 *   ② /github-bot actions   → 生成 GitHub Actions workflow（最后一步）
 *
 * 依赖关系：Actions workflow 需要 secrets，必须先创建 App。
 */

import { Command } from './command.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { execSync, spawnSync } from 'child_process'

// ── gh CLI 封装 ──────────────────────────────────────────────────────────────

function checkGh(): { ok: boolean; user?: string } {
  try {
    execSync('gh auth status', { stdio: 'ignore' })
    const login = execSync('gh api /user --jq .login', { encoding: 'utf-8' }).trim()
    return { ok: true, user: login }
  } catch {
    return { ok: false }
  }
}

function gh(args: string): string {
  try {
    return execSync(`gh ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch (err: any) {
    throw new Error((err.stderr?.toString() || err.stdout?.toString() || err.message).trim())
  }
}

function ghApi(apiPath: string, method = 'GET'): any {
  return JSON.parse(gh(`api ${apiPath} --method ${method}`))
}

function ghSecretSet(name: string, value: string, repo: string): void {
  const result = spawnSync('gh', ['secret', 'set', name, '--repo', repo], { input: value, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `gh secret set ${name} failed`)
}

function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? `open "${url}"`
      : process.platform === 'linux' ? `xdg-open "${url}"`
      : process.platform === 'win32' ? `start "" "${url}"`
      : null
    if (cmd) execSync(cmd, { stdio: 'ignore' })
  } catch { /* 忽略 */ }
}

function openFile(filePath: string): void {
  openUrl(filePath)
}

// ── 本地回调服务器 ─────────────────────────────────────────────────────────

/**
 * 启动一个本地 HTTP server 来捕获 GitHub 的 redirect 回调。
 * GitHub 创建 App 后会重定向到 redirect_url?code=XXX，这个 server 负责接收。
 *
 * 返回 port（用于构建 manifest 的 redirect_url）和 codePromise（resolve 时拿到 code）。
 * 5 分钟超时。
 */
function startCallbackServer(): Promise<{ port: number; codePromise: Promise<string> }> {
  return new Promise((resolveServer, rejectServer) => {
    const server = http.createServer()
    let port: number

    // ── code 捕获 Promise ──────────────────────────────────────────
    let resolveCode: (code: string) => void
    let rejectCode: (err: Error) => void
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })

    // ── 超时 ───────────────────────────────────────────────────────
    const TIMEOUT_MS = 300_000 // 5 分钟
    let timeout: NodeJS.Timeout

    // ── 请求处理 ───────────────────────────────────────────────────
    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://localhost:${port}`)
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code')
          if (code) {
            clearTimeout(timeout)
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            res.end(
              '<!DOCTYPE html>' +
              '<html><head><meta charset="utf-8"><title>✅ GitHub App 创建成功</title></head>' +
              '<body style="font-family:system-ui;text-align:center;padding:60px;background:#f6f8fa;">' +
              '<div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,.12);">' +
              '<h1 style="color:#1a7f37;">✅ GitHub App 创建成功！</h1>' +
              '<p style="color:#656d76;font-size:16px;">正在终端中自动配置 Secrets…</p>' +
              '<p style="color:#656d76;font-size:14px;">此页面可以关闭</p>' +
              '</div></body></html>'
            )
            server.close()
            resolveCode(code)
          } else {
            res.writeHead(400)
            res.end('Missing code parameter')
          }
        } else if (url.pathname === '/favicon.ico') {
          res.writeHead(204) // No Content
          res.end()
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
      } catch (err: any) {
        // 解析 URL 失败等，忽略
        res.writeHead(500)
        res.end('Internal error')
      }
    })

    // ── 启动监听 ───────────────────────────────────────────────────
    server.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        rejectServer(new Error('无法获取服务器端口'))
        return
      }
      port = addr.port

      // 启动超时定时器
      timeout = setTimeout(() => {
        server.close()
        rejectCode(new Error('等待超时（5分钟），未收到 GitHub 回调。请检查浏览器是否完成了 App 创建。'))
      }, TIMEOUT_MS)

      resolveServer({ port, codePromise })
    })

    server.on('error', (err) => {
      clearTimeout(timeout)
      server.close()
      rejectServer(err)
    })
  })
}

// ── Manifest ─────────────────────────────────────────────────────────────────

function buildManifest(owner: string, repo: string, callbackPort: number) {
  return {
    name: `myagent-${owner}`.substring(0, 34),
    url: `https://github.com/${owner}/${repo}`,
    description: 'myagent — AI-powered GitHub bot for auto-fixing issues and creating PRs',
    public: false,
    redirect_url: `http://localhost:${callbackPort}/callback`,
    default_permissions: {
      issues: 'write',
      pull_requests: 'write',
      contents: 'write',
      metadata: 'read',
    },
    default_events: [] as string[],
  }
}

/**
 * 生成一个临时 HTML 文件，内含 auto-submit form，用 POST 方式提交 manifest 到 GitHub。
 * 这是 GitHub 官方要求的 Manifest 流程（必须 POST，不能 GET）。
 *
 * 返回临时文件路径。
 */
function writeManifestHtml(manifest: object): string {
  const manifestJson = JSON.stringify(manifest)
  // 嵌入 JS 时需要转义 </script> 防止提前闭合
  const safeJson = manifestJson.replace(/<\//g, '<\\/')

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>创建 GitHub App — myagent</title>
  <style>
    body { font-family: system-ui; text-align: center; padding: 60px; background: #f6f8fa; }
    .card { max-width: 480px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    h1 { color: #24292f; font-size: 20px; }
    p { color: #656d76; font-size: 14px; margin: 12px 0; }
    .spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid #d0d7de; border-top-color: #0969da; border-radius: 50%; animation: spin .6s linear infinite; margin-bottom: -6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    a { color: #0969da; }
  </style>
</head>
<body>
  <div class="card">
    <h1><span class="spinner"></span> 正在跳转到 GitHub…</h1>
    <p>即将打开 GitHub App 创建页面，表单字段已预填。</p>
    <p>请在 GitHub 页面确认并点击 <strong>Create GitHub App</strong>。</p>
    <p style="margin-top:20px;">如未自动跳转，请 <a href="#" onclick="document.getElementById('f').submit();return false;">点击此处</a></p>
  </div>
  <form id="f" action="https://github.com/settings/apps/new" method="post" style="display:none;">
    <input type="hidden" name="manifest" id="m">
  </form>
  <script>
    document.getElementById('m').value = JSON.stringify(${safeJson});
    setTimeout(function() { document.getElementById('f').submit(); }, 500);
  </script>
</body>
</html>`

  const tmpDir = os.tmpdir()
  const htmlPath = path.join(tmpDir, `myagent-manifest-${Date.now()}.html`)
  fs.writeFileSync(htmlPath, html, 'utf-8')
  return htmlPath
}

// ── Workflow 模板 ────────────────────────────────────────────────────────────

export function buildWorkflowYaml(myagentRepo: string): string {
  let slug = myagentRepo
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
  if (!slug.includes('/')) slug = myagentRepo

  return `\
# myagent GitHub Bot — 自动修复 issue 并提 PR
# 由 /github-bot actions 自动生成
name: myagent bot

concurrency:
  group: myagent-\${{ github.event.issue.number }}
  cancel-in-progress: true

on:
  issue_comment:
    types: [created]

jobs:
  bot:
    if: |
      contains(github.event.comment.body, '@myagent') &&
      !github.event.issue.pull_request
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          path: repo

      - uses: actions/checkout@v4
        with:
          repository: \${{ secrets.MYAGENT_REPO }}
          path: .myagent

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Cache myagent node_modules
        uses: actions/cache@v4
        with:
          path: .myagent/node_modules
          key: \${{ runner.os }}-myagent-\${{ hashFiles('.myagent/package-lock.json') }}

      - name: Install myagent dependencies
        run: cd .myagent && npm ci

      - name: Cache repo node_modules
        uses: actions/cache@v4
        with:
          path: repo/node_modules
          key: \${{ runner.os }}-repo-\${{ hashFiles('repo/package-lock.json') }}

      - name: Install repo dependencies
        run: cd repo && npm ci || true

      - name: Generate GitHub App token
        uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: \${{ secrets.MYAGENT_APP_ID }}
          private-key: \${{ secrets.MYAGENT_PRIVATE_KEY }}

      - name: Run myagent bot
        working-directory: repo
        env:
          GITHUB_TOKEN: \${{ steps.app-token.outputs.token }}
          GITHUB_REPOSITORY: \${{ github.repository }}
          MYAGENT_ISSUE_NUMBER: \${{ github.event.issue.number }}
          MYAGENT_ISSUE_TITLE: \${{ github.event.issue.title }}
          MYAGENT_COMMENT_USER: \${{ github.event.comment.user.login }}
          MYAGENT_COMMENT_BODY: \${{ github.event.comment.body }}
        run: |
          npx tsx ../.myagent/src/agent.ts --debug \\
            "处理 GitHub issue #\$MYAGENT_ISSUE_NUMBER: \$MYAGENT_ISSUE_TITLE\\
            触发用户: @\$MYAGENT_COMMENT_USER" \\
            --auto-yes \\
            --wait-for-bg 300 \\
            --timeout 1500
`
}

// ── 命令 ──────────────────────────────────────────────────────────────────────

export class GitHubBotCommand extends Command {
  constructor(private askQuestion: (prompt: string) => Promise<string>) {
    super()
  }

  get name(): string { return 'github-bot' }
  get description(): string { return '设置 myagent GitHub Bot' }
  get usage(): string { return '/github-bot app  |  /github-bot actions [repo]  |  /github-bot status' }

  async execute(args: string[]): Promise<void> {
    const sub = args[0] ?? 'help'
    switch (sub) {
      case 'app':     return this.doApp()
      case 'actions': return this.doActions(args.slice(1))
      case 'status':  return this.doStatus()
      default:
        console.log('用法:')
        console.log('  ① /github-bot app                    创建 GitHub App（一条命令完成）')
        console.log('  ② /github-bot actions [myagent-repo] 生成 GitHub Actions workflow')
        console.log('     /github-bot status                查看配置状态')
        console.log('')
        console.log('执行顺序: app → actions')
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // /github-bot app — 一条命令完成 GitHub App 创建全流程
  //
  //   ① 启动本地 HTTP server 监听回调
  //   ② 生成 HTML form（POST manifest）
  //   ③ 打开浏览器 → 用户确认 → GitHub 回调本地 server
  //   ④ 自动捕获 code → 兑换 App ID + PEM → gh secret set → 引导安装
  // ══════════════════════════════════════════════════════════════════════

  private async doApp(): Promise<void> {
    const ghStatus = checkGh()
    if (!ghStatus.ok) {
      console.log('❌ 需要 gh CLI 并认证。安装: https://cli.github.com/  认证: gh auth login')
      return
    }
    if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
      console.log('❌ 当前目录不是 git 仓库')
      return
    }
    let owner: string, repo: string
    try {
      [owner, repo] = gh('repo view --json nameWithOwner --jq .nameWithOwner').split('/')
    } catch {
      console.log('❌ 无法获取仓库信息')
      return
    }

    console.log(`✓ gh 已认证 (${ghStatus.user})`)
    console.log(`📦 仓库: ${owner}/${repo}`)
    console.log('')

    // ── ① 启动本地回调服务器 ──────────────────────────────────────
    console.log('启动本地回调服务...')
    let port: number
    let codePromise: Promise<string>
    try {
      const result = await startCallbackServer()
      port = result.port
      codePromise = result.codePromise
    } catch (err: any) {
      console.log(`❌ 启动本地服务失败: ${err.message}`)
      return
    }
    console.log(`✓ 回调服务已启动 (端口 ${port})`)
    console.log('')

    // ── ② 生成 HTML + 打开浏览器 ───────────────────────────────────
    const manifest = buildManifest(owner, repo, port)
    const htmlPath = writeManifestHtml(manifest)

    // macOS/Linux: 直接传路径（open /path/to/file.html）
    // Windows: 需要用 file:/// URL
    const fileUrl = process.platform === 'win32'
      ? `file:///${htmlPath.replace(/\\/g, '/')}`
      : htmlPath
    openFile(fileUrl)

    console.log('━━━ 创建 GitHub App ━━━')
    console.log('')
    console.log('浏览器已打开，表单字段已预填：')
    console.log(`  App 名称: ${manifest.name}`)
    console.log(`  权限: issues:write, pull_requests:write, contents:write`)
    console.log('')
    console.log('请在页面中点击 "Create GitHub App"')
    console.log('（之后无需手动粘贴 code，将自动完成配置）')
    console.log('')

    // ── ③ 等待 GitHub 回调 → 自动获取 code ────────────────────────
    console.log('等待 GitHub 回调...')
    let code: string
    try {
      code = await codePromise
    } catch (err: any) {
      console.log(`❌ ${err.message}`)
      return
    }
    console.log('✓ 已收到 GitHub 回调')
    console.log('')

    // ── ④ gh api 兑换 code → app_id + pem ─────────────────────────
    console.log('正在兑换凭证...')
    let appId: string, pem: string, appSlug: string
    try {
      const result = ghApi(`/app-manifests/${code}/conversions`, 'POST')
      appId = String(result.id)
      pem = result.pem
      appSlug = result.slug ?? `myagent-${owner}`.substring(0, 34).toLowerCase()
    } catch (err: any) {
      console.log(`❌ 兑换失败: ${err.message}`)
      console.log('   code 可能已过期（有效时间很短）。请重新执行 /github-bot app')
      return
    }
    if (!pem) {
      console.log('❌ 兑换成功但未返回私钥，请重试')
      console.log('   重新执行 /github-bot app 即可')
      return
    }
    console.log(`✓ GitHub App 创建成功！App ID: ${appId}`)
    console.log('')

    // ── ⑤ gh secret set ────────────────────────────────────────────
    const myagentRepo = `${owner}/${repo}`
    console.log('正在配置仓库 Secrets...')
    try {
      ghSecretSet('MYAGENT_APP_ID', appId, myagentRepo)
      console.log('✓ MYAGENT_APP_ID')
      ghSecretSet('MYAGENT_PRIVATE_KEY', pem, myagentRepo)
      console.log('✓ MYAGENT_PRIVATE_KEY')
      ghSecretSet('MYAGENT_REPO', myagentRepo, myagentRepo)
      console.log('✓ MYAGENT_REPO')
    } catch (err: any) {
      console.log(`⚠️  gh secret set 失败: ${err.message}`)
      console.log('   请在 Settings → Secrets and variables → Actions 中手动设置:')
      console.log(`   MYAGENT_APP_ID = ${appId}`)
      console.log('   MYAGENT_PRIVATE_KEY = （pem 仅出现一次，需重新执行 /github-bot app）')
      console.log(`   MYAGENT_REPO = ${myagentRepo}`)
      return
    }
    console.log('')

    // ── ⑥ 安装 App ─────────────────────────────────────────────────
    const installUrl = `https://github.com/settings/apps/${appSlug}/installations`
    openUrl(installUrl)

    console.log('━━━ 安装 App 到仓库 ━━━')
    console.log(`  ${installUrl}`)
    console.log('  选择你的仓库 → Install')
    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✅ GitHub App 配置完成！')
    console.log('')
    console.log('下一步: /github-bot actions')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  }

  // ══════════════════════════════════════════════════════════════════════
  // /github-bot actions [myagent-repo]
  //   生成 .github/workflows/myagent-bot.yml（最后一步）
  // ══════════════════════════════════════════════════════════════════════

  private async doActions(repoArgs: string[]): Promise<void> {
    const ghStatus = checkGh()
    if (!ghStatus.ok) {
      console.log('❌ 需要 gh CLI 并认证')
      return
    }
    if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
      console.log('❌ 当前目录不是 git 仓库')
      return
    }
    let owner: string, repo: string
    try {
      [owner, repo] = gh('repo view --json nameWithOwner --jq .nameWithOwner').split('/')
    } catch {
      console.log('❌ 无法获取仓库信息')
      return
    }

    const myagentRepo = repoArgs.join(' ').trim() || `${owner}/${repo}`

    const wfDir = path.join(process.cwd(), '.github', 'workflows')
    try {
      fs.mkdirSync(wfDir, { recursive: true })
      fs.writeFileSync(path.join(wfDir, 'myagent-bot.yml'), buildWorkflowYaml(myagentRepo), 'utf-8')
    } catch (err: any) {
      console.log(`❌ 写入 workflow 文件失败: ${err.message}`)
      return
    }

    console.log(`✓ gh 已认证 (${ghStatus.user})`)
    console.log(`📦 仓库: ${owner}/${repo}`)
    console.log(`🤖 myagent: ${myagentRepo}`)
    console.log('✓ 已生成 .github/workflows/myagent-bot.yml')
    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✅ GitHub Actions 配置完成！')
    console.log('')
    console.log('验证: 创建 issue → 评论 @myagent fix this')
    console.log('确保已配置 Secrets: MYAGENT_APP_ID, MYAGENT_PRIVATE_KEY, MYAGENT_REPO')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  }

  // ══════════════════════════════════════════════════════════════════════

  private async doStatus(): Promise<void> {
    const wf = path.join(process.cwd(), '.github/workflows/myagent-bot.yml')
    console.log('GitHub Bot 状态:')
    console.log(`  Actions workflow: ${fs.existsSync(wf) ? '✓ 已生成' : '✗ 未生成 → /github-bot actions'}`)
    try {
      console.log(`  gh CLI:           ✓ ${gh('api /user --jq .login')}`)
    } catch {
      console.log('  gh CLI:           ✗ 未认证')
    }
    try {
      const secrets = JSON.parse(gh('secret list --json name'))
      for (const s of ['MYAGENT_APP_ID', 'MYAGENT_PRIVATE_KEY', 'MYAGENT_REPO']) {
        const found = (secrets as Array<{name: string}>).some(x => x.name === s)
        console.log(`  Secret ${s}: ${found ? '✓' : '✗ 未设置'}`)
      }
    } catch {
      console.log('  Secrets: 无法检查（可能需要 repo admin 权限）')
    }
  }
}
