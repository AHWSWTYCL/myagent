// Smoke test for teammate runtime + launcher
import { parseTeammateArgs } from './teammateRuntime.js'
import { createLauncher, formatLaunchResult } from './launcher.js'

// Test 1: CLI parsing
console.log('=== Test 1: parseTeammateArgs ===')
const opts1 = parseTeammateArgs(['node', 'agent.ts', '--teammate', '--id', 'wk-test-1', '--leader', 'main', '--role', 'tester', '--tools', 'read_file,bash'])
if (!opts1) { console.error('FAIL: opts1 should not be null'); process.exit(1) }
console.log('--teammate flag:', JSON.stringify(opts1, null, 2))

const opts2 = parseTeammateArgs(['node', 'agent.ts', 'teammate', '--id', 'wk-gen-2', '--team', 'demo', '--tools', 'write_file,glob'])
if (!opts2) { console.error('FAIL: opts2 should not be null'); process.exit(1) }
console.log('teammate sub:', JSON.stringify(opts2, null, 2))

const opts3 = parseTeammateArgs(['node', 'agent.ts'])
if (opts3 !== null) { console.error('FAIL: opts3 should be null for normal mode'); process.exit(1) }
console.log('normal mode: null (correct)')

// Test 2: Launcher - command formatting (not actually launching)
console.log('\n=== Test 2: Launch result formatting ===')
const mockResult = {
  mode: 'manual' as const,
  agentId: 'wk-test-1',
  command: 'cd /Users/test && npm run agent -- teammate --id "wk-test-1" --leader "main" --role "tester" --tools "read_file,bash"',
  success: true,
  error: 'Please run manually in a new Warp pane',
}
console.log(formatLaunchResult(mockResult))

// Test 3: Launcher creation
console.log('\n=== Test 3: createLauncher ===')
const launcher = createLauncher()
console.log('Launcher type:', launcher.constructor.name)

console.log('\n=== All smoke tests passed ===')
