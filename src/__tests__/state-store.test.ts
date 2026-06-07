import { describe, expect, it, vi } from 'vitest'
import { createStore } from '../state/store.js'
import { createSignal } from '../state/signal.js'

describe('createStore', () => {
  it('updates state and notifies subscribers', () => {
    const store = createStore({ count: 0 })
    const listener = vi.fn()
    store.subscribe(listener)

    store.setState(prev => ({ ...prev, count: prev.count + 1 }))

    expect(store.getState().count).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('skips notifications when updater returns the same object', () => {
    const initial = { count: 0 }
    const onChange = vi.fn()
    const store = createStore(initial, onChange)
    const listener = vi.fn()
    store.subscribe(listener)

    store.setState(prev => prev)

    expect(store.getState()).toBe(initial)
    expect(listener).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('unsubscribes listeners', () => {
    const store = createStore({ count: 0 })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    unsubscribe()
    store.setState(prev => ({ ...prev, count: 1 }))

    expect(listener).not.toHaveBeenCalled()
  })

  it('passes old and new state to onChange', () => {
    const onChange = vi.fn()
    const store = createStore({ count: 0 }, onChange)

    store.setState(prev => ({ ...prev, count: 2 }))

    expect(onChange).toHaveBeenCalledWith({
      oldState: { count: 0 },
      newState: { count: 2 },
    })
  })
})

describe('createSignal', () => {
  it('emits args to subscribers and supports clear', () => {
    const signal = createSignal<[string]>()
    const listener = vi.fn()
    signal.subscribe(listener)

    signal.emit('changed')
    signal.clear()
    signal.emit('ignored')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('changed')
  })
})
