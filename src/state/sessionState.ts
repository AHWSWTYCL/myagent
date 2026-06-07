import type Anthropic from '@anthropic-ai/sdk'
import type { UsageAccum } from '../utils/runagent.js'

export class SessionState {
  readonly messages: Anthropic.MessageParam[] = []
  agentRunning = false
  lastUsage: UsageAccum | null = null
  continuedFromSession: string | undefined

  hydrate(messages: Anthropic.MessageParam[], sessionId?: string): void {
    this.messages.splice(0, this.messages.length, ...messages)
    this.continuedFromSession = sessionId
  }

  appendMessage(message: Anthropic.MessageParam): void {
    this.messages.push(message)
  }

  appendMessages(...messages: Anthropic.MessageParam[]): void {
    this.messages.push(...messages)
  }

  replaceMessages(messages: Anthropic.MessageParam[]): void {
    this.messages.splice(0, this.messages.length, ...messages)
  }

  setRunning(running: boolean): void {
    this.agentRunning = running
  }

  setUsage(usage: UsageAccum | null): void {
    this.lastUsage = usage
  }
}

export const sessionState = new SessionState()
