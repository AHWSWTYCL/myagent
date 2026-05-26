import { projectBuilderAgent } from './src/agents/builtin/project_builder.js';

console.log('name:', projectBuilderAgent.name);
console.log('maxTurns:', projectBuilderAgent.maxTurns);
console.log('tools:', JSON.stringify(projectBuilderAgent.tools));
console.log('inputSchema required:', JSON.stringify(projectBuilderAgent.inputSchema?.required));
console.log('inputSchema properties:', JSON.stringify(Object.keys(projectBuilderAgent.inputSchema?.properties || {})));
console.log('extraTools type:', typeof projectBuilderAgent.extraTools);

const bt = projectBuilderAgent.extraTools();
console.log('BuildBashTool name:', bt[0].name);
console.log('BuildBashTool input_schema:', JSON.stringify(bt[0].input_schema));

// test formatUserMessage
const ctx = { emitLine: (s) => console.log('[emitLine]', s) };
const msg = projectBuilderAgent.formatUserMessage(
  { task: '搭建环境并构建项目', project_path: '/test/path' },
  ctx
);
console.log('\n=== With project_path ===');
console.log(msg);

const msg2 = projectBuilderAgent.formatUserMessage(
  { task: '构建' },
  ctx
);
console.log('\n=== Without project_path ===');
console.log(msg2);

// test BuildBashTool
const result = await bt[0].execute({ command: 'echo "hello build tool"' });
console.log('\n=== BuildBashTool echo test ===');
console.log(result);
