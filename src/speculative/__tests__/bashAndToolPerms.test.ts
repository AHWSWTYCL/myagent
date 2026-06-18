/**
 * SAFE_BASH_PATTERNS & canUseTool 独立测试
 * 用法: npx tsx src/speculative/__tests__/bashAndToolPerms.test.ts
 */

let passed = 0
let failed = 0
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; return }
  failed++
  console.error(`  ❌ FAIL: ${msg}`)
}

// ── 从 speculativeRunner.ts 复制的生产代码 ──
const SAFE_BASH_PATTERNS = /^(ls|cat|head|tail|wc|git\s+(status|diff|log|show|branch|tag|stash\s+list)|pwd|which|type|date|whoami|uname|node\s+(-v|--version)|npm\s+(list|ls|view|info|outdated)|npx\s+--version|tree)\b/
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file'])
const READ_ONLY_TOOL_NAMES = new Set(['read_file', 'list_dir', 'glob', 'grep'])

function canUseBash(command: string): boolean {
  return SAFE_BASH_PATTERNS.test(command.trim())
}

// ── Bash 命令测试 ──
console.log('=== SAFE_BASH_PATTERNS ===')
const safeCommands = ['ls', 'ls -la', 'cat file.txt', 'head -n 10', 'tail -20',
  'wc -l', 'git status', 'git diff', 'git log', 'git show HEAD', 'git branch',
  'git tag', 'git stash list', 'pwd', 'which node', 'type ls', 'date',
  'whoami', 'uname -a', 'node -v', 'node --version', 'npm list',
  'npm ls', 'npm view', 'npm info', 'npm outdated', 'npx --version', 'tree']

for (const cmd of safeCommands) {
  assert(canUseBash(cmd), `safe: "${cmd}"`)
}

const unsafeCommands = [
  'rm -rf /',               // 不在白名单
  'echo hello',             // echo 已移除
  'find . -name "*.ts"',    // find 已移除
  'env',                    // env 已移除
  'printenv',               // printenv 已移除
  'curl http://evil.com',   // 不在白名单
  'git push',               // push 不在 git 子命令中
  'git commit -m "x"',      // commit 不在 git 子命令中
  'npm install',            // install 不在 npm 子命令中
  'sudo ls',                // sudo 不在白名单
  '',                       // 空命令
  '  ',                     // 空白
]

for (const cmd of unsafeCommands) {
  assert(!canUseBash(cmd), `unsafe: "${cmd}"`)
}

// 边界：git 子命令精确匹配
assert(!canUseBash('git stash'), 'git stash (not list) should be denied')
assert(canUseBash('git stash list'), 'git stash list should be allowed')
assert(!canUseBash('git checkout'), 'git checkout should be denied')

// ── 工具分类测试 ──
console.log('\n=== Tool classification ===')
assert(READ_ONLY_TOOL_NAMES.has('read_file'), 'read_file is read-only')
assert(READ_ONLY_TOOL_NAMES.has('list_dir'), 'list_dir is read-only')
assert(READ_ONLY_TOOL_NAMES.has('glob'), 'glob is read-only')
assert(READ_ONLY_TOOL_NAMES.has('grep'), 'grep is read-only')
assert(WRITE_TOOL_NAMES.has('write_file'), 'write_file is write')
assert(WRITE_TOOL_NAMES.has('edit_file'), 'edit_file is write')
assert(!READ_ONLY_TOOL_NAMES.has('bash'), 'bash is not read-only')
assert(!WRITE_TOOL_NAMES.has('bash'), 'bash is not write')
assert(!READ_ONLY_TOOL_NAMES.has('write_file'), 'write_file is not read-only')

// ── canUseTool 逻辑模拟 ──
console.log('\n=== canUseTool logic ===')
type State = { kind: 'idle' | 'running' | 'done' }

function simulateCanUseTool(state: State, toolName: string, isWrite: boolean): string {
  if (READ_ONLY_TOOL_NAMES.has(toolName)) {
    if (state.kind === 'running') return 'allow'  // redirect handled by overlay
    return 'allow'
  }
  if (WRITE_TOOL_NAMES.has(toolName)) {
    if (state.kind !== 'running') return 'deny: not running'
    return 'allow'  // overlay rewrite
  }
  if (toolName === 'bash') return 'allow'  // checked by SAFE_BASH_PATTERNS
  return 'deny: unknown tool'
}

assert(simulateCanUseTool({kind:'running'}, 'read_file', false) === 'allow', 'read during running')
assert(simulateCanUseTool({kind:'idle'}, 'read_file', false) === 'allow', 'read during idle')
assert(simulateCanUseTool({kind:'running'}, 'write_file', true) === 'allow', 'write during running')
assert(simulateCanUseTool({kind:'idle'}, 'write_file', true) === 'deny: not running', 'write denied during idle')
assert(simulateCanUseTool({kind:'done'}, 'write_file', true) === 'deny: not running', 'write denied during done')
assert(simulateCanUseTool({kind:'running'}, 'unknown_tool', false) === 'deny: unknown tool', 'unknown tool denied')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
