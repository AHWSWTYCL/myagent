import type { PermissionAnswer } from '../hooks/permissionhook.js'

export type MessageRole = 'user' | 'agent' | 'tool' | 'system'

export interface ToolCallPayload {
  /** Tool name, as registered (e.g. "bash", "read_file"). */
  name: string
  /** Raw tool input (already JSON-decoded). */
  input: unknown
  /** Stringified tool result. */
  output: string
  /** Whether the tool reported an error (output starts with "Error:" etc). */
  isError?: boolean
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  /** Optional structured payload — when present, MessageRow renders via ToolCallView. */
  toolCall?: ToolCallPayload
  /**
   * Per-round exploration tool summary, archived by turnToolReset.
   * When present, MessageRow renders a TurnSummary component (GlowingDot + Ctrl+O to expand).
   * Multiple entries = one per LLM round.
   */
  explorationSummary?: {
    readCount: number
    searchCount: number
    listCount: number
    tools: TurnToolItem[]
    anyError: boolean
  }
}

export interface PermissionEvent {
  prompt: string
  resolve: (answer: PermissionAnswer) => void
}

export interface QuestionEvent {
  prompt: string
  resolve: (answer: string) => void
}

export interface ChoiceQuestion {
  id: string
  prompt: string
  options: { value: string; label: string }[]
  /** If true, an "Other…" option is appended. When selected, the user can type a custom value. */
  allowOther?: boolean
}

export type ChoiceResult =
  | { status: 'submitted'; answers: Record<string, string> }
  | { status: 'cancelled' }

export interface ChoiceEvent {
  questions: ChoiceQuestion[]
  resolve: (result: ChoiceResult) => void
}

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * A tool call in progress or completed, within a single user turn.
 *
 * Claude Code groups all tool calls from a user's single message into one
 * visual group, even when they span multiple LLM response rounds. Each item
 * carries its own status so the group can contain mixed pending/completed state.
 */
export interface TurnToolItem {
  id: string
  name: string
  input: unknown
  output: string
  isError: boolean
  isPending: boolean
  liveOutput?: string
  isHeartbeating?: boolean
}
