import { describe, expect, it } from 'vitest'
import { createStore } from '../state/store.js'
import { getDefaultAppState } from '../state/appState.js'
import { TuiBridge } from '../tui/bridge.js'

describe('TuiBridge AppState adapter', () => {
  it('cycles mode in shared state (default → auto → plan)', () => {
    const store = createStore(getDefaultAppState())
    const bridge = new TuiBridge(store)

    // Default is 'auto'
    expect(bridge.mode).toBe('auto')
    expect(bridge.isAutoMode).toBe(true)

    // auto → plan
    expect(bridge.cycleMode()).toBe('plan')
    expect(store.getState().mode).toBe('plan')
    expect(store.getState().planPreviousMode).toBe('auto')

    // plan → default
    expect(bridge.cycleMode()).toBe('default')
    expect(store.getState().mode).toBe('default')
    expect(store.getState().planPreviousMode).toBeNull()

    // default → auto
    expect(bridge.cycleMode()).toBe('auto')
    expect(store.getState().mode).toBe('auto')
  })

  it('enterPlanMode and exitPlanMode preserve previous mode', () => {
    const store = createStore(getDefaultAppState())
    const bridge = new TuiBridge(store)

    // Start from auto
    expect(bridge.enterPlanMode()).toBe('plan')
    expect(store.getState().mode).toBe('plan')
    expect(store.getState().planPreviousMode).toBe('auto')

    // Exit restores to auto
    expect(bridge.exitPlanMode()).toBe('auto')
    expect(store.getState().mode).toBe('auto')
    expect(store.getState().planPreviousMode).toBeNull()
  })

  it('tracks background count without going below zero', () => {
    const store = createStore(getDefaultAppState())
    const bridge = new TuiBridge(store)

    bridge.emitBackgroundStart()
    bridge.emitBackgroundStart()
    bridge.emitBackgroundEnd()
    bridge.emitBackgroundEnd()
    bridge.emitBackgroundEnd()

    expect(bridge.backgroundCount).toBe(0)
    expect(store.getState().backgroundCount).toBe(0)
  })

  it('updates usage and status state', () => {
    const store = createStore(getDefaultAppState())
    const bridge = new TuiBridge(store)

    bridge.emitStatus('thinking...')
    bridge.emitUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })

    expect(store.getState().status).toBe('thinking...')
    expect(store.getState().usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })

    bridge.emitUsageReset()

    expect(store.getState().usage).toBeNull()
  })

  it('updates sub-agent and teammate state', () => {
    const store = createStore(getDefaultAppState())
    const bridge = new TuiBridge(store)

    bridge.emitSubAgentStart('explore', 'Inspect files', 'Explore')
    bridge.emitSubAgentProgress('explore', 2, 100, 'Reading files')
    bridge.emitSubAgentDone('explore', 'completed')

    expect(store.getState().subAgentTasks).toHaveLength(1)
    expect(store.getState().subAgentTasks[0]).toMatchObject({
      name: 'explore',
      status: 'completed',
      toolUseCount: 2,
      tokenCount: 100,
      lastActivity: 'Reading files',
    })
  })
})
