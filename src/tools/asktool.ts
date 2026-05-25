import { Tool, type ToolPermissionResult } from './tool.js'

interface AskUserArgs {
  prompt: string
}

/**
 * 开放式提问工具：在 TUI 弹出输入框，等待用户的自由文本回答。
 * 与 ask_user_choice 的区别：这里没有候选项，专门用于无法预设选项的需求挖掘场景
 * （比如让用户描述使用场景、解释边界 case、补充背景）。
 */
export class AskTool extends Tool {
  constructor(private askQuestion: (prompt: string) => Promise<string>) {
    super()
  }

  get name(): string {
    return 'ask_user'
  }

  get description(): string {
    return [
      'Ask the user a single open-ended question and wait for a free-form text answer.',
      'Use this when you need information that cannot be captured by a multiple-choice question — e.g. clarifying intent, gathering domain context, eliciting acceptance criteria during requirement analysis.',
      'Prefer ask_user_choice when the answer space is small and enumerable.',
      'Returns the user\'s answer as a plain string. An empty string means the user submitted nothing.',
      'Ask one focused question at a time; do not batch unrelated questions into one prompt.',
    ].join(' ')
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: 'The question text shown to the user. Be specific and self-contained.',
        },
      },
      required: ['prompt'],
    }
  }

  get parallelSafe(): boolean { return false }

  /** 用户交互工具，再走权限确认就成了循环提问，直接放行。 */
  async checkPermission(): Promise<ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: AskUserArgs): Promise<string> {
    if (!args.prompt || typeof args.prompt !== 'string') {
      return 'Error: prompt must be a non-empty string.'
    }
    const answer = await this.askQuestion(args.prompt)
    return answer ?? ''
  }
}
