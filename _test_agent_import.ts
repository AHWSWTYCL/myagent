// Just test that the agent module loads without errors
console.log('Testing agent.ts module resolution...');
const mod = await import('./src/agent.js');
console.log('Module keys:', Object.keys(mod));
console.log('Has runBash:', typeof mod.runBash);
console.log('Has runTurn:', typeof mod.runTurn);
console.log('✅ agent.ts module loaded');
