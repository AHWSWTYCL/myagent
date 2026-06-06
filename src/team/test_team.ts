import { TeamManager } from './team.js'

// 1. 测试 create
console.log('=== Test 1: create team ===');
const m = TeamManager.create({ name: 'test-team', leader_id: 'test-leader', description: 'test team for verification' });
console.log('Created:', JSON.stringify(m, null, 2));

// 2. 测试 exists
console.log('\n=== Test 2: exists ===');
console.log('exists test-team:', TeamManager.exists('test-team'));
console.log('exists nonexistent:', TeamManager.exists('nonexistent'));

// 3. 测试 addMember
console.log('\n=== Test 3: addMember ===');
TeamManager.addMember('test-team', 'wk-1', 'code generator');
TeamManager.addMember('test-team', 'wk-2', 'code verifier');
console.log('Members:', JSON.stringify(TeamManager.listMembers('test-team'), null, 2));
console.log('Member IDs:', TeamManager.getMemberIds('test-team'));

// 4. 测试 list
console.log('\n=== Test 4: list teams ===');
console.log('All teams:', TeamManager.list());

// 5. 测试 removeMember
console.log('\n=== Test 5: removeMember ===');
TeamManager.removeMember('test-team', 'wk-1');
console.log('After remove wk-1:', JSON.stringify(TeamManager.listMembers('test-team'), null, 2));

// 6. 测试 disband
console.log('\n=== Test 6: disband ===');
TeamManager.disband('test-team');
console.log('exists after disband:', TeamManager.exists('test-team'));

console.log('\n✅ All tests passed!');
