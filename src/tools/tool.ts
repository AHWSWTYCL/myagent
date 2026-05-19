export class Tool {

  get name(): string {
    return 'tool';
  }
  
  get description(): string {
    return 'A tool for executing a specific task';
  }

  get input_schema(): { type: 'object'; properties: object; required: string[] } {
    return {
      type: 'object',
      properties: {},
      required: [],
    };
  }

  get output_schema(): object {
    return {
      type: 'object',
      properties: {},
      required: [],
    };
  }

  /** Whether this tool is safe to run concurrently with other tools (no side effects, no permission prompts). */
  get parallelSafe(): boolean {
    return false
  }

  async execute(args: any): Promise<string> {
    throw new Error(`Tool "${this.name}" does not implement execute()`)
  }
}