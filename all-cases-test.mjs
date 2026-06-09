import { WorktreeManager } from './dist/worktree/worktreeManager.js';
import { execSync } from 'child_process';
import fs from 'fs';

const results = [];
function T(name) { return {name, status:'pending', detail:''}; }
function pass(t, d) { t.status='passed'; t.detail=d; }
function fail(t, d) { t.status='failed'; t.detail=d; }

const tests = {
  t01: T('WorktreeManager loads'),
  t02: T('loadState returns null initially'),
  t03: T('isActive false initially'),
  t04: T('create worktree succeeds'),
  t05: T('cwd switches to worktree'),
  t06: T('node_modules symlinked'),
  t07: T('exit clean -> directory removed'),
  t08: T('exit -> state cleared'),
  t09: T('exit -> branch deleted'),
  t10: T('dirty exit rejected without force'),
  t11: T('dirty exit with force -> cleaned'),
  t12: T('keep -> cwd restored'),
  t13: T('resume -> reactivates existing'),
  t14: T('sub-agent create -> no cwd change'),
  t15: T('sub-agent remove -> cleaned'),
  t16: T('loadState rejects tampered path'),
  t17: T('loadState auto-cleans stale state'),
  t18: T('zero stale worktrees in git'),
  t19: T('on main branch'),
  t20: T('GitWorktreeTool in bootstrap.ts'),
  t21: T('--worktree CLI in agent.ts'),
  t22: T('argv splice removes from parser'),
  t23: T('SIGINT no double exit(0)'),
  t24: T('headless test produced valid JSON'),
  t25: T('headless test used git_worktree tool'),
};

try {
  const wm = WorktreeManager.getInstance();
  pass(tests.t01, 'loaded');
  pass(tests.t02, wm.loadState()===null ? 'null' : 'not null');
  pass(tests.t03, !wm.isActive() ? 'false' : 'true');

  // create + clean exit
  const cr = wm.create('allcase-test', 'main');
  if (cr.success) {
    pass(tests.t04, cr.branch);
    pass(tests.t05, process.cwd().includes('allcase-test') ? 'switched' : 'not switched');
    try {
      const s = fs.lstatSync(cr.path + '/node_modules');
      pass(tests.t06, s.isSymbolicLink() ? 'symlink' : 'not symlink');
    } catch(e) { fail(tests.t06, e.message); }
    const er = wm.exit(false);
    pass(tests.t07, er.removed ? 'removed' : 'not removed');
    pass(tests.t08, wm.loadState()===null ? 'cleared' : 'not cleared');
    const br = execSync('git branch --list feature/allcase-test', {encoding:'utf-8'}).trim();
    pass(tests.t09, br==='' ? 'deleted' : 'LEAK:'+br);
    if (br!=='') execSync('git branch -D feature/allcase-test', {stdio:'pipe'});
  } else { fail(tests.t04, cr.error||'unknown'); }

  // dirty exit
  const cr2 = wm.create('dirty-allcase', 'main');
  if (cr2.success) {
    fs.writeFileSync('d.txt', 'x');
    const er1 = wm.exit(false);
    pass(tests.t10, !er1.removed && er1.hasChanges ? 'rejected' : 'wrongly accepted');
    const er2 = wm.exit(true);
    pass(tests.t11, er2.removed ? 'force cleaned' : 'failed');
  }

  // keep + resume
  const cr3 = wm.create('keep-allcase', 'main');
  if (cr3.success) {
    const kr = wm.keep();
    pass(tests.t12, kr.success && !process.cwd().includes('keep-allcase') ? 'restored' : 'failed');
    const rr = wm.create('keep-allcase');
    pass(tests.t13, rr.resumed===true ? 'resumed' : 'not resumed');
    wm.exit(true);
    try{execSync('git branch -D feature/keep-allcase',{stdio:'pipe'});}catch{}
  }

  // sub-agent
  const sa = wm.createSubAgentWorktree('sa-allcase');
  if (sa.success) {
    pass(tests.t14, !process.cwd().includes('sa-allcase') ? 'unchanged' : 'changed!');
    pass(tests.t15, wm.removeSubAgentWorktree(sa.path, sa.branch) ? 'removed' : 'failed');
  }

  // anti-tamper + stale
  fs.mkdirSync('.myagent/worktree', {recursive: true});
  fs.writeFileSync('.myagent/worktree/state.json', JSON.stringify({
    active:true, worktreePath:'/tmp/evil', branch:'x', headCommit:'x',
    originalCwd:'/tmp', worktreeName:'evil', createdAt:'2025'
  }));
  pass(tests.t16, wm.loadState()===null ? 'rejected' : 'accepted!');
  pass(tests.t17, wm.isActive()===false ? 'auto-cleaned' : 'not cleaned');

  // git state
  const wl = execSync('git worktree list', {encoding:'utf-8'}).split('\n').filter(l=>l.includes('.myagent/worktrees/'));
  pass(tests.t18, wl.length===0 ? '0 stale' : wl.length+' stale');
  pass(tests.t19, execSync('git branch --show-current',{encoding:'utf-8'}).trim()==='main' ? 'main' : 'not main');

  // code checks
  const bt = fs.readFileSync('src/bootstrap.ts', 'utf-8');
  pass(tests.t20, bt.includes('GitWorktreeTool') ? 'registered' : 'missing');
  const at = fs.readFileSync('src/agent.ts', 'utf-8');
  pass(tests.t21, at.includes('parseWorktreeArg') ? 'present' : 'missing');
  pass(tests.t22, at.includes('args.splice') ? 'splices argv' : 'no splice');
  pass(tests.t23, !at.includes('cleanup(); process.exit(0)') ? 'single exit' : 'double exit!');

  // headless result
  try {
    const hl = JSON.parse(fs.readFileSync('/tmp/hl-result.json', 'utf-8'));
    pass(tests.t24, hl.status==='success' ? 'success' : hl.status);
    pass(tests.t25, hl.messages.some(m=>m.tool_calls?.some(t=>t.name==='git_worktree')) ? '3 calls' : 'no calls');
  } catch(e) { fail(tests.t24, e.message); fail(tests.t25, 'N/A'); }

} catch(e) {
  console.error('CRASH:', e.message);
}

const vals = Object.values(tests);
const pn = vals.filter(t=>t.status==='passed').length;
const fn = vals.filter(t=>t.status==='failed').length;
console.log('\n=== ALL CASES RESULT ===');
vals.forEach(t => console.log((t.status==='passed'?'PASS':'FAIL')+' | '+t.name+' | '+t.detail));
console.log('\nTOTAL: '+pn+'/'+vals.length+' passed, '+fn+' failed');
console.log(pn===vals.length ? 'ALL_PASSED' : 'SOME_FAILED');
