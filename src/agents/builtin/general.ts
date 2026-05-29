import { AgentDefinition } from '../definition.js'

const SYSTEM = `You are a helpful sub-agent. Complete the given task using the tools available to you. ` +
  `Be thorough; the caller cannot see your intermediate steps, only your final summary.

## Guidelines

1. **工具调用纪律**: 每次工具调用完成后，等待并读取返回结果再做下一步。不要假设或猜测结果内容。
2. **错误处理**: 工具调用返回错误时，先诊断原因再决定下一步，不要静默忽略。非致命错误应在最终报告中注明。
3. **输出完整性**: 最终输出必须包含执行总结，让调用方能直接理解你做了什么、结果如何、有什么需要注意的事项。
4. **边界意识**: 只使用分配给你的工具集完成职责范围内的工作。不要越权访问其他 agent 的工具，不要修改未授权的文件。`

export const generalPurposeAgent: AgentDefinition = {
  name: 'general-purpose',
  description:
    'Generic delegate agent. Spawn this when a task can be fully delegated and its result summarized back. ' +
    'Has read_file / write_file / list_dir / bash. Prefer specialized agents (explore, planner, generator, verifier) ' +
    'when their description fits the task.',
  systemPrompt: SYSTEM,
  tools: ['read_file', 'write_file', 'list_dir', 'bash'],
  maxTurns: 20,
}
