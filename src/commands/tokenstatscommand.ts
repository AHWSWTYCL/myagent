import { Command } from './command.js'
import type { UsageAccum } from '../utils/runagent.js'
import type Anthropic from '@anthropic-ai/sdk'
import {
  estimateTokens,
  MICRO_COMPACT_TOKEN_THRESHOLD,
  COMPACT_TOKEN_THRESHOLD,
} from '../utils/compact.js'

export class TokenStatsCommand extends Command {
  constructor(
    private usageAccum: () => UsageAccum | null,
    private messages: () => Anthropic.MessageParam[],
  ) {
    super()
  }

  get name(): string {
    return 'token_stats'
  }

  get description(): string {
    return '显示当前会话的 token 使用统计'
  }

  get usage(): string {
    return '/token_stats'
  }

  async execute(_args: string[]): Promise<void> {
    const usage = this.usageAccum()
    const msgs = this.messages()

    if (!usage && msgs.length === 0) {
      console.log('  (还没有 API 调用记录，请先发几条消息再运行 /token_stats)')
      return
    }

    const estimatedTokens = estimateTokens(msgs)
    // lastUsage.inputTokens reflects the actual tokens sent in the last API call
    // (full history included), which is what compactIfNeeded uses for thresholds.
    // Fall back to the char-based estimate when no API call has been made yet.
    const contextTokens = usage?.inputTokens ?? estimatedTokens

    const labelWidth = 30
    const numWidth = 12

    const label = (s: string) => s.padEnd(labelWidth)
    const num = (n: number) => n.toLocaleString().padStart(numWidth)

    // ── API 用量 ──────────────────────────────────────────────────────────────
    console.log('')
    console.log('  ┌────────────────────────────────────────────┐')
    console.log('  │         📊 Token 使用统计                  │')
    console.log('  ├────────────────────────────────────────────┤')
    console.log('  │ ■ 累计 API 用量                            │')
    console.log('  ├────────────────────────────────────────────┤')
    console.log(`  │ ${label('累计 input tokens:')} ${num(usage?.inputTokens ?? 0)} │`)
    console.log(`  │ ${label('累计 output tokens:')} ${num(usage?.outputTokens ?? 0)} │`)
    console.log(`  │ ${label('累计 cache read tokens:')} ${num(usage?.cacheReadTokens ?? 0)} │`)
    console.log(`  │ ${label('累计 cache write tokens:')} ${num(usage?.cacheWriteTokens ?? 0)} │`)

    // ── 上下文估算 ────────────────────────────────────────────────────────────
    const msgCount = msgs.length
    const avgTokensPerMsg = msgCount > 0 ? Math.round(estimatedTokens / msgCount) : 0

    console.log('  ├────────────────────────────────────────────┤')
    console.log('  │ ■ 当前上下文估算                           │')
    console.log('  ├────────────────────────────────────────────┤')
    console.log(`  │ ${label('消息总数:')} ${num(msgCount)} │`)
    console.log(`  │ ${label('实际上下文 tokens:')} ${num(contextTokens)} │`)
    console.log(`  │ ${label('(字符估算 tokens):')} ${num(estimatedTokens)} │`)
    console.log(`  │ ${label('平均 token/条:')} ${num(avgTokensPerMsg)} │`)

    // ── Compact 阈值 ──────────────────────────────────────────────────────────
    const toMicro = Math.max(0, MICRO_COMPACT_TOKEN_THRESHOLD - contextTokens)
    const toCompact = Math.max(0, COMPACT_TOKEN_THRESHOLD - contextTokens)

    console.log('  ├────────────────────────────────────────────┤')
    console.log('  │ ■ Compact 阈值                             │')
    console.log('  ├────────────────────────────────────────────┤')
    console.log(`  │ ${label('Microcompact 阈值:')} ${num(MICRO_COMPACT_TOKEN_THRESHOLD)} │`)
    console.log(`  │ ${label('Compact 阈值:')} ${num(COMPACT_TOKEN_THRESHOLD)} │`)
    console.log(`  │ ${label('距 microcompact 还剩:')} ${num(toMicro)} │`)
    console.log(`  │ ${label('距 compact 还剩:')} ${num(toCompact)} │`)

    // ── 进度条 ────────────────────────────────────────────────────────────────
    if (contextTokens > 0) {
      const microPct = Math.min(100, Math.round((contextTokens / MICRO_COMPACT_TOKEN_THRESHOLD) * 100))
      const compactPct = Math.min(100, Math.round((contextTokens / COMPACT_TOKEN_THRESHOLD) * 100))

      const bar = (pct: number, width = 20): string => {
        const filled = Math.floor((pct / 100) * width)
        return '█'.repeat(filled) + '░'.repeat(width - filled)
      }

      const pctLabel = (pct: number) => pct < 100 ? `${pct}%` : '⚠️ FULL'
      const pctPad = (s: string) => s.padStart(6)

      console.log('  ├────────────────────────────────────────────┤')
      console.log(`  │ ${label('Microcompact 进度:')} ${bar(microPct)} ${pctPad(pctLabel(microPct))} │`)
      console.log(`  │ ${label('Compact 进度:')}      ${bar(compactPct)} ${pctPad(pctLabel(compactPct))} │`)
    }

    console.log('  └────────────────────────────────────────────┘')
    console.log('')
  }
}
