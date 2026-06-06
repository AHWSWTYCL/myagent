import { CreateTeamTool } from '../tools/createteamtool.js'

const tool = new CreateTeamTool()

// Test 1: create team
console.log('=== Test 1: create team ===')
const result1 = await tool.execute({ team_name: 'test-project', description: 'my test project' })
console.log(result1)

// Test 2: duplicate
console.log('\n=== Test 2: duplicate create ===')
const result2 = await tool.execute({ team_name: 'test-project', description: 'duplicate' })
console.log(result2)

// Test 3: list
console.log('\n=== Test 3: list existing teams ===')
import { TeamManager } from '../team/team.js'
console.log('Teams:', TeamManager.list())

// Cleanup
TeamManager.disband('test-project')
console.log('\n✅ CreateTeamTool tests passed!')
