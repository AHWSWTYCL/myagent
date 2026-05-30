import { z } from 'zod'
import { Tool, type ToolPermissionResult, type ToolRenderHeader } from './tool.js'
import type { ChoiceQuestion, ChoiceResult } from '../tui/types.js'

interface ChoiceToolArgs {
  questions: {
    id: string
    prompt: string
    options: { value: string; label: string }[]
  }[]
}

export class ChoiceTool extends Tool {
  constructor(private askChoice: (questions: ChoiceQuestion[]) => Promise<ChoiceResult>) {
    super()
  }

  get name(): string {
    return 'ask_user_choice'
  }

  get description(): string {
    return [
      'Ask the user one or more multiple-choice questions in a single batch.',
      'Use this when you need to confirm decisions, gather preferences, or clarify requirements before proceeding.',
      'The user sees all questions at once, picks one option per question, then submits or cancels.',
      'Returns JSON `{"status":"submitted","answers":{questionId: optionValue, ...}}` on submit, or `{"status":"cancelled"}` if the user cancels.',
    ].join(' ')
  }

  get inputSchemaZod() {
    return z.object({
      questions: z.array(z.object({
        id: z.string().describe('Stable identifier used as the key in the returned answers map.'),
        prompt: z.string().describe('The question text shown to the user.'),
        options: z.array(z.object({
          value: z.string().describe('Machine-readable value returned when this option is chosen.'),
          label: z.string().describe('Human-readable label shown in the TUI.'),
        })).min(2).max(6).describe('2-6 mutually exclusive choices.'),
        allowOther: z.boolean().optional().describe('If true, an "Other…" option is appended for custom input.'),
      })).min(1).describe('List of questions to ask. Keep ids short and unique.'),
    })
  }

  get outputSchemaZod() {
    return z.string()
  }

  get parallelSafe(): boolean { return false }

  renderToolUseMessage(_input: Record<string, unknown>): ToolRenderHeader {
    return { label: 'AskUserChoice', args: '' }
  }

  /** ChoiceTool 本身就是用户交互工具，再走权限确认就是循环提问，直接放行。 */
  async checkPermission(): Promise<ToolPermissionResult> {
    return { action: 'continue' }
  }

  async execute(args: ChoiceToolArgs): Promise<string> {
    if (!Array.isArray(args.questions) || args.questions.length === 0) {
      return 'Error: questions must be a non-empty array.'
    }
    for (const q of args.questions) {
      if (!q.id || !q.prompt || !Array.isArray(q.options) || q.options.length < 2) {
        return `Error: question "${q.id ?? '(no id)'}" must have an id, a prompt, and at least 2 options.`
      }
    }

    const result = await this.askChoice(args.questions)
    return JSON.stringify(result)
  }
}
