import { Tool } from './tool.js'
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

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object' as const,
      properties: {
        questions: {
          type: 'array',
          description: 'List of questions to ask. Keep ids short and unique.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable identifier used as the key in the returned answers map.' },
              prompt: { type: 'string', description: 'The question text shown to the user.' },
              options: {
                type: 'array',
                description: '2-6 mutually exclusive choices.',
                items: {
                  type: 'object',
                  properties: {
                    value: { type: 'string', description: 'Machine-readable value returned when this option is chosen.' },
                    label: { type: 'string', description: 'Human-readable label shown in the TUI.' },
                  },
                  required: ['value', 'label'],
                },
              },
              allowOther: { type: 'boolean', description: 'If true, an "Other…" option is appended for custom input.' },
            },
            required: ['id', 'prompt', 'options'],
          },
        },
      },
      required: ['questions'],
    }
  }

  get parallelSafe(): boolean { return false }

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
