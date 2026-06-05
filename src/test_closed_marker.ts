import { TranscriptRecorder, loadLatestCheckpoint } from './utils/transcript.js'
import fs from 'fs'
import path from 'path'

// === Test 1: closed session is found ===
console.log('=== Test 1: Closed session is found ===')
const recorder = new TranscriptRecorder()
recorder.initSession('test-continue')
const sessionDir = (recorder as any).sessionDir
console.log('Session dir:', sessionDir)

fs.writeFileSync(path.join(sessionDir, 'checkpoint-1.json'), JSON.stringify({
  seq: 1,
  timestamp: new Date().toISOString(),
  messageCount: 1,
  tokenEstimate: 10,
  messages: [{ role: 'user', content: 'test message from -c test' }]
}), 'utf-8')

recorder.closeSession() // writes .closed

const cp = loadLatestCheckpoint()
console.log('Found session:', cp?.sessionId)
console.log('Match:', cp?.sessionId === path.basename(sessionDir) ? '✓' : '✗')

// === Test 2: Session without .closed is skipped ===
console.log('\n=== Test 2: Unclosed session is skipped ===')
const recorder2 = new TranscriptRecorder()
recorder2.initSession()
const dir2 = (recorder2 as any).sessionDir
console.log('Unclosed session dir:', dir2)
fs.writeFileSync(path.join(dir2, 'checkpoint-1.json'), JSON.stringify({
  seq: 1,
  timestamp: new Date().toISOString(),
  messageCount: 1,
  tokenEstimate: 5,
  messages: [{ role: 'user', content: 'should NOT be loaded' }]
}), 'utf-8')
// Don't close - simulate crash

// Should still find the first (closed) session
const cp2 = loadLatestCheckpoint()
console.log('Found session:', cp2?.sessionId)
console.log('Still finds closed session:', cp2?.sessionId === path.basename(sessionDir) ? '✓' : '✗')
console.log('NOT the unclosed one:', cp2?.sessionId !== path.basename(dir2) ? '✓' : '✗')

// Cleanup
fs.rmSync(dir2, { recursive: true, force: true })
console.log('\nCleanup done.')

process.exit(0)
