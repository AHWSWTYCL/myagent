export class Tool {

  get name(): string {
    return 'tool';
  }
  
  get description(): string {
    return 'A tool for executing a specific task';
  }

  get input_schema(): object {
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

  execute(args: any): string {
    return `Executing ${this.name} with args ${JSON.stringify(args)}`;
  }
}