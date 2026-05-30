/**
 * Attachment 基类 — 表示一条「可以提供给 LLM 的系统状态变更」。
 */
export abstract class Attachment {
  abstract get type(): string
  abstract get summary(): string
  abstract get content(): string

  readonly timestamp: number = Date.now()
  readonly source: string

  constructor(source: string) {
    this.source = source
  }
}
