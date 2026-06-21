import { describe, it, expect, beforeEach } from 'vitest'
import { SpeculativeRunner } from '../speculative/speculativeRunner.js'
import { QuestionAutofillManager } from '../tui/QuestionAutofillManager.js'
import { sessionState } from '../state/sessionState.js'

// ── QuestionAutofillManager ──────────────────────────────────────────────────

describe('QuestionAutofillManager', () => {
  it('disabled by default', () => {
    const m = new QuestionAutofillManager()
    expect(m.enabled).toBe(false)
  })

  it('setEnabled toggles', () => {
    const m = new QuestionAutofillManager()
    m.setEnabled(true)
    expect(m.enabled).toBe(true)
    m.setEnabled(false)
    expect(m.enabled).toBe(false)
  })

  it('toggle flips and returns new value', () => {
    const m = new QuestionAutofillManager()
    expect(m.toggle()).toBe(true)
    expect(m.enabled).toBe(true)
    expect(m.toggle()).toBe(false)
    expect(m.enabled).toBe(false)
  })

  it('generateSuggestion returns null when disabled', async () => {
    const m = new QuestionAutofillManager()
    // disabled — should not make API call
    const result = await m.generateSuggestion('What is your name?', 'context')
    expect(result).toBeNull()
  })
})

// ── SpeculativeRunner edge cases ─────────────────────────────────────────────

describe('SpeculativeRunner — startSpeculation guard', () => {
  let runner: SpeculativeRunner

  beforeEach(() => {
    runner = new SpeculativeRunner()
    sessionState.replaceMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('does not start when agentRunning=true', async () => {
    sessionState.setRunning(true)
    await runner.startSpeculation('guess', {
      tools: new Map(),
      buildSystemSegments: () => [],
    })
    expect(runner.state.kind).toBe('idle')
    sessionState.setRunning(false)
  })

  it('initial state is idle', () => {
    expect(runner.state.kind).toBe('idle')
    expect(runner.isRunning).toBe(false)
    expect(runner.isDone).toBe(false)
  })

  it('accept() on idle returns null', async () => {
    expect(await runner.accept()).toBeNull()
  })

  it('discard() on idle is a no-op', async () => {
    await expect(runner.discard()).resolves.toBeUndefined()
    expect(runner.state.kind).toBe('idle')
  })
})

describe('SpeculativeRunner — defaultCanUseTool', () => {
  let runner: SpeculativeRunner

  beforeEach(() => {
    runner = new SpeculativeRunner()
  })

  it('read tools allowed in idle state', async () => {
    const r = await runner.defaultCanUseTool('read_file', { filePath: 'x.ts' }, false)
    expect(r.allowed).toBe(true)
  })

  it('write tools denied outside running state', async () => {
    const r = await runner.defaultCanUseTool('write_file', { filePath: 'x.ts' }, true)
    expect(r.allowed).toBe(false)
  })

  it('unknown tool denied', async () => {
    const r = await runner.defaultCanUseTool('dangerous_tool', {}, false)
    expect(r.allowed).toBe(false)
  })

  it('safe bash commands allowed', async () => {
    const r = await runner.defaultCanUseTool('bash', { command: 'ls -la' }, false)
    expect(r.allowed).toBe(true)
  })

  it('unsafe bash commands denied', async () => {
    const r = await runner.defaultCanUseTool('bash', { command: 'rm -rf /' }, false)
    expect(r.allowed).toBe(false)
  })

  it('empty bash command denied', async () => {
    const r = await runner.defaultCanUseTool('bash', { command: '' }, false)
    expect(r.allowed).toBe(false)
  })

  it('git push denied (not in safe list)', async () => {
    const r = await runner.defaultCanUseTool('bash', { command: 'git push origin main' }, false)
    expect(r.allowed).toBe(false)
  })

  it('git status allowed', async () => {
    const r = await runner.defaultCanUseTool('bash', { command: 'git status' }, false)
    expect(r.allowed).toBe(true)
  })
})

describe('SpeculativeRunner — state transitions via accept/discard', () => {
  it('aborted state: accept returns null and resets to idle', async () => {
    const runner = new SpeculativeRunner()
    ;(runner as any)._state = { kind: 'aborted', reason: 'test' }
    const result = await runner.accept()
    expect(result).toBeNull()
    expect(runner.state.kind).toBe('idle')
  })

  it('done state: accept returns result with includesUserMessage=true', async () => {
    const runner = new SpeculativeRunner()
    ;(runner as any)._state = {
      kind: 'done',
      overlay: { accept: async () => {}, discard: async () => {} },
      result: {
        messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
        boundary: { type: 'complete', completedAt: Date.now(), turnText: '' },
        timeSavedMs: 500,
        includesUserMessage: true,
      },
    }
    const result = await runner.accept()
    expect(result).not.toBeNull()
    expect(result!.includesUserMessage).toBe(true)
    expect(result!.boundary?.type).toBe('complete')
    expect(runner.state.kind).toBe('idle')
  })

  it('running state: accept incomplete strips ghostText and ends on assistant', async () => {
    const runner = new SpeculativeRunner()
    ;(runner as any)._state = {
      kind: 'running',
      abortController: new AbortController(),
      overlay: { accept: async () => {}, discard: async () => {} },
      startTime: Date.now() - 100,
      boundary: null,
      ghostTextIndex: 2,
      messagesRef: {
        current: [
          { role: 'user', content: 'original' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'ghostText' },
          { role: 'assistant', content: 'partial' },
          { role: 'user', content: 'tool_result' },
        ],
      },
    }
    ;(runner as any)._runPromise = Promise.resolve()
    const result = await runner.accept()
    expect(result).not.toBeNull()
    expect(result!.includesUserMessage).toBe(false)
    expect(result!.boundary?.type).toBe('incomplete')
    expect(result!.messages[result!.messages.length - 1]?.role).toBe('assistant')
    // ghostText stripped, trailing user popped → original, reply, partial = 3
    expect(result!.messages.length).toBe(3)
    expect(runner.state.kind).toBe('idle')
  })
})
