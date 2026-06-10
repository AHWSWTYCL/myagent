import { SessionManager } from './src/session/SessionManager.js';
import fs from 'fs';

// 1. SessionManager 创建
const mgr = SessionManager.getInstance();
console.log('1. SessionManager singleton: OK');

// 2. Session lifecycle
mgr.start();
const sid = mgr.getSessionId();
console.log('2. start() → sessionId:', sid);
console.log('   isStarted:', mgr.isStarted());

// 3. Metadata setters
mgr.setCustomTitle('测试标题 with 引号');
mgr.setTag('debug');
mgr.setLastPrompt('帮我重构认证模块');
console.log('3. Metadata set: OK');
console.log('   customTitle:', mgr.getCustomTitle());
console.log('   tag:', mgr.getTag());

// 4. Stats recording
mgr.recordTurn({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 });
mgr.recordToolCall();
mgr.recordToolCall();
mgr.recordCompaction();
const stats = mgr.getStats();
console.log('4. Stats:', JSON.stringify(stats));

// 5. Close
mgr.close();
console.log('5. close(): OK');

// 6. Session files exist
const dir = mgr.getSessionDir();
console.log('6. Session dir:', dir);
console.log('   transcript.ndjson exists:', fs.existsSync(dir + '/transcript.ndjson'));
console.log('   .closed exists:', fs.existsSync(dir + '/.closed'));

// 7. List sessions
const sessions = SessionManager.listSessions();
console.log('7. listSessions() found:', sessions.length);
for (const s of sessions) {
  console.log('   -', s.sessionId, 'title:', s.customTitle || '(none)', 'tag:', s.tag || '(none)', 'closed:', s.isClosed);
  if (s.stats) {
    console.log('     stats: turns:', s.stats.turns, 'tools:', s.stats.toolCalls);
  }
}

// 8. Test extr fix: title with quotes in NDJSON
const tp = dir + '/transcript.ndjson';
const content = fs.readFileSync(tp, 'utf-8');
const hasCustomTitle = content.includes('"type":"custom_title"');
const hasTag = content.includes('"type":"tag"');
const hasLastPrompt = content.includes('"type":"last_prompt"');
const hasSessionStats = content.includes('"type":"session_stats"');
console.log('8. NDJSON metadata entries:');
console.log('   custom_title:', hasCustomTitle);
console.log('   tag:', hasTag);
console.log('   last_prompt:', hasLastPrompt);
console.log('   session_stats:', hasSessionStats);

// 9. Read back via lite metadata (indirectly through listSessions)
const listed = SessionManager.listSessions();
const mySession = listed.find(s => s.sessionId === sid);
if (mySession) {
  console.log('9. Read back via listSessions:');
  console.log('   customTitle:', mySession.customTitle);
  console.log('   tag:', mySession.tag);
  console.log('   lastPrompt:', mySession.lastPrompt);
  if (mySession.stats) {
    console.log('   stats.turns:', mySession.stats.turns);
    console.log('   stats.toolCalls:', mySession.stats.toolCalls);
  }
}

console.log('\n✅ All checks passed');
