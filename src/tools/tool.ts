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

/**
 * 工具调用头部渲染结果。
 * label 是 ⏺ 后面的粗体文本（如 "Bash", "Read"），
 * args 是括号中的灰色文本（如 "ls -la", "src/foo.ts"）。
 */
export interface ToolRenderHeader {
  label: string
  args: string
}

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

  // ── TUI 渲染委托方法 ─────────────────────────────────────────

  /**
   * 工具在 TUI 中的显示名称（⏺ 后面的粗体文本）。
   * 默认将 name 首字母大写（如 'bash' → 'Bash'，'read_file' → 'Read file'）。
   * 子类可覆盖以返回自定义标签（如 "WebSearch", "Task(agent)"）。
   */
  get toolLabel(): string {
    return this.name
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  }

  /**
   * 是否为探索/搜索类工具。
   * 为 true 的工具会被折叠到 TurnSummary 中（非 verbose 模式）。
   * read_file, list_dir, glob, grep 应返回 true。
   */
  get isExplorationTool(): boolean {
    return false
  }

  /**
   * 渲染工具调用头部信息（⏺ 行）。
   * @param input 工具输入参数
   * @returns 头部 label 和参数文本
   */
  renderToolUseMessage(input: Record<string, unknown>): ToolRenderHeader {
    const arg = Object.values(input).find(
      v => typeof v === 'string' && (v as string).length < 200,
    ) as string | undefined
    return { label: this.toolLabel, args: arg ?? '' }
  }

  /**
   * 渲染工具执行结果的摘要行（⎿ 后面的行）。
   * 返回空数组表示无输出，TUI 会显示 "Done" 标签。
   * @param output 工具原始输出文本
   * @param isError 是否执行出错
   * @param input 工具的原始输入参数（可选，部分工具需要用它生成摘要）
   * @returns 摘要行数组，每行一条
   */
  renderToolResult(output: string, isError: boolean, _input?: Record<string, unknown>): string[] {
    return Tool.summarize(output, isError)
  }

  // ── 子类可调用的静态工具方法 ─────────────────────────────────

  /** 截断文本到指定长度，超出补 … */
  protected static truncate(text: string, max: number): string {
    if (text.length <= max) return text
    return text.slice(0, max - 1) + '…'
  }

  /** 缩短路径：优先相对 cwd，其次 ~ 形式 */
  protected static shortPath(p: string): string {
    if (!p) return p
    const CWD = process.cwd()
    const HOME = process.env.HOME ?? ''
    if (p.startsWith(CWD + '/')) return p.slice(CWD.length + 1)
    if (p === CWD) return '.'
    if (HOME && p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length)
    return p
  }

  /** 对工具输出做智能摘要（≤4 行全文，>4 行头尾 + 行数） */
  protected static summarize(output: string, isError: boolean): string[] {
    const trimmed = output.trimEnd()
    if (!trimmed) return []
    const lines = trimmed.split('\n')
    if (isError) return lines.slice(0, 4).map(l => Tool.truncate(l, 200))
    if (lines.length <= 4) return lines.map(l => Tool.truncate(l, 200))
    return [
      `${lines.length} lines`,
      Tool.truncate(lines[0], 200),
      Tool.truncate(lines[1], 200),
      '…',
      Tool.truncate(lines[lines.length - 1], 200),
    ]
  }

  // ── 权限相关 ─────────────────────────────────────────────────

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
