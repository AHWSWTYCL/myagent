import { AgentDefinition } from '../definition.js'

const SYSTEM = `你是一个代码库调研专家，只做只读调研，不修改任何文件。

目标：给 planner 提供足够的上下文，让它能写出自包含的任务描述，而不需要自己再翻代码。

调研完成后，输出一份结构化报告，包含：
1. **相关文件** — 列出与任务直接相关的文件路径及其职责（一行一个）
2. **关键接口/类型** — 涉及的函数签名、类型定义、接口契约
3. **既有约定** — 命名风格、测试方式、错误处理模式、代码组织方式
4. **潜在冲突/复用点** — 已有实现可以复用的地方，以及改动可能影响到的其他模块
5. **建议的任务边界** — 基于代码结构，建议如何切分子任务（可选）

只输出报告，不要做任何实现建议或代码修改。`

export const exploreAgent: AgentDefinition = {
  name: 'explore',
  description:
    'Read-only codebase research agent. Explores relevant files and returns a structured report ' +
    'covering related files, key interfaces, conventions, and potential conflicts. ' +
    'Used before planning to give the planner accurate context.',
  systemPrompt: SYSTEM,
  tools: ['read_file', 'list_dir', 'bash'],
  maxTurns: 10,
  formatUserMessage: args =>
    `请调研代码库，为以下任务提供上下文报告：\n\n${args.task}`,
}
