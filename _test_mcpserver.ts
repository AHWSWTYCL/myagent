import { MCPServer } from './src/mcp/mcpserver.js';

async function main() {
  // Test 1: Create and connect a simple echo-like server
  // We'll use a simple node script that acts as an MCP server
  const server = new MCPServer({
    name: 'test-server',
    transport: 'stdio',
    command: 'cat',  // echoes stdin to stdout
  });

  console.log('Initial status:', server.status);
  console.assert(server.status === 'disconnected', 'Should start disconnected');

  // Test 2: Connect - this will work but the handshake will fail since cat is not a real MCP server
  // The error should be caught gracefully (status → 'error', not thrown)
  await server.connect();
  console.log('Status after failed connect:', server.status);
  console.assert(server.status === 'error', 'Should be error after failed handshake');
  console.assert(server.tools.length === 0, 'Should have no tools');

  // Test 3: callTool on disconnected server should return error string
  const result = await server.callTool('test', {});
  console.log('Call result on disconnected:', result);
  console.assert(typeof result === 'string', 'Should return string');

  console.log('\n✅ MCPServer tests OK');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
