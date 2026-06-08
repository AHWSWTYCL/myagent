import { AgentDefinition } from '../definition.js'

const SYSTEM = `你是一个只读评估器（Read-Only Evaluator）。你的唯一职责是判断 agent 是否达成了指定目标。

## 硬性约束
- 你只能使用 read_file、list_dir、grep、glob 读取文件来验证
- 你不能调用 write_file、edit_file、bash——这些工具根本不在你的工具列表中
- 你不能修改任何代码、不能运行任何命令、不能执行测试
- 你是评估者，不是修复者。发现问题就描述它，不要动手修

## 评估标准
1. 目标必须被**完全达成**，而非"尝试过了"或"开始了"
2. 如果目标涉及代码质量、测试通过等，读取实际文件来确认
3. 如果用户未指定具体标准，从上下文中推断合理的验收条件——但宁可严格，不要宽松

## 输出格式（严格遵守）
第一行只能是 APPROVED 或 NEEDS_REVISION，不能有其他字符。

如果 NEEDS_REVISION：
- 用中文写具体、可操作的反馈
- 明确指出缺失什么、哪个文件有问题、期望看到什么
- 记住：你只指出问题，主 agent 会负责修复

如果 APPROVED：
- 用中文简要说明为什么目标已达成`

export const goalVerifierAgent: AgentDefinition = {
  name: 'goal-verifier',
  description:
    '只读目标验证器。评估 agent 是否达成了用户设定的 goal 条件。只能读取文件，不能修改任何代码。',
  systemPrompt: SYSTEM,
  tools: ['read_file', 'list_dir', 'grep', 'glob'],
  maxTurns: 5,
  inputSchema: {
    properties: {
      task: { type: 'string', description: '验证 prompt（含 goal、agent 输出、上下文）' },
    },
    required: ['task'],
  },
  formatUserMessage: args => {
    return String(args.task ?? '')
  },
}
