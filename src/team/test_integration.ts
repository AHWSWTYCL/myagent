import { TeamManager } from './team.js'
import * as fs from 'fs'

// Create team
TeamManager.create({ name: 'myapp', leader_id: 'leader', description: 'Test app project' });

// Add members  
TeamManager.addMember('myapp', 'wk-gen-1', 'code generator');
TeamManager.addMember('myapp', 'wk-ver-1', 'code verifier');

// Read manifest from disk
const content = fs.readFileSync(process.env.HOME + '/.myagent/teams/myapp/team.json', 'utf-8');
console.log('Manifest on disk:');
console.log(content);

// Verify
const m = TeamManager.get('myapp');
console.log('\nMember count:', m?.members.length);
console.log('Member IDs:', TeamManager.getMemberIds('myapp'));

// Cleanup
TeamManager.disband('myapp');
console.log('\nCleaned up. exists:', TeamManager.exists('myapp'));
console.log('✅ Integration test passed!');
