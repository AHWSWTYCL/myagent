import { describe, expect, it } from 'vitest'
import { createStore } from '../state/store.js'
import { getDefaultAppState } from '../state/appState.js'
import { TuiBridge } from '../tui/bridge.js'

describe('TuiBridge AppState adapter', () => {
  it('toggles auto mode in shared state', () => {
    const store = createStore(getDefaultAppState())
    const bridge = new TuiBridge(store)

    expect(bridge.autoMode).toBe(true)
    expect(bridge.toggleAutoMode()).toBe(false)
    expect(store.getState().autoMode).toBe(false)
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
