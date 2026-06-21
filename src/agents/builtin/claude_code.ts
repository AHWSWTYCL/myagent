import { AgentDefinition } from '../definition.js'

/**
 * Claude Code 内嵌 agent。
 *
 * 不走正常的 sub-agent LLM 循环（runAgent），而是在 AgentTool 中特判：
 * agentType === 'external-process' 时直接 spawn 外部 CLI 进程，
 * 调用 `claude -p "<prompt>"` 非交互模式。
 *
 * 这样 Claude Code 可以使用自己的全套 tools、权限系统和 API key，
 * 与 myagent 的 tool 系统完全隔离。
 */
export const claudeCodeAgent: AgentDefinition = {
  name: 'claude_code',
  description:
    '内嵌的 Claude Code CLI（-p 非交互模式）。在当前工作目录下执行任务，' +
    '可使用 Claude Code 的全部工具（Bash、Read、Write、Grep 等）。' +
    '适合需要 Claude Code 原生能力（如 Git 操作、复杂 shell 命令）的场景。' +
    '结果以纯文本形式返回。',
  agentType: 'external-process',
  systemPrompt: '', // 不走 LLM 循环，无需 system prompt
  tools: [], // 不走 LLM 循环，无需工具
  maxTurns: 0, // 不走 LLM 循环
  formatUserMessage: args => {
    const task = String(args.task ?? '')
    return task
  },
}
