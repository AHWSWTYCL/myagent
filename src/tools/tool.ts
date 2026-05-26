/**
 * 工具权限检查结果
 * - continue: 工具自身认为该操作是安全的，跳过后续所有权限检查
 * - block: 工具自身认为该操作是危险的，直接阻断
 * - defer: 工具无法判断，交由上层（auto/manual）决定
 */
export type ToolPermissionResult =
  | { action: 'continue' }
  | { action: 'block'; reason: string }
  | { action: 'defer' }

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

  /**
   * 工具自身的权限检查。
   * 在权限 hook 链中，此方法会在 auto-mode 之前被调用。
   * 默认行为是 defer（交由上层决策），子类按需覆盖。
   */
  async checkPermission(_args: Record<string, unknown>): Promise<ToolPermissionResult> {
    return { action: 'defer' }
  }

  /**
   * @param _args 工具参数（来自 LLM 的 tool call）
   * @param _signal 可选的 AbortSignal，用于取消正在执行的操作（如长时间运行的 bash 命令）
   */
  async execute(_args: any, _signal?: AbortSignal): Promise<string> {
    throw new Error(`Tool "${this.name}" does not implement execute()`)
  }
}
