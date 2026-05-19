import type { PermissionAnswer } from '../hooks/permissionhook.js'

export type MessageRole = 'user' | 'agent' | 'tool' | 'system'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
}

export interface PermissionEvent {
  prompt: string
  resolve: (answer: PermissionAnswer) => void
}

export interface QuestionEvent {
  prompt: string
  resolve: (answer: string) => void
}

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
