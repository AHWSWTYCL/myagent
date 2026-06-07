import { describe, expect, it, vi } from 'vitest'
import { MessageQueue } from '../messagequeue.js'

describe('MessageQueue', () => {
  it('dequeues user messages by priority and keeps FIFO within the same priority', () => {
    const queue = new MessageQueue()

    queue.enqueue('later-1', 'later')
    queue.enqueue('next-1')
    queue.enqueue('now-1', 'now')
    queue.enqueue('next-2')

    expect(queue.dequeue()).toBe('now-1')
    expect(queue.dequeue()).toBe('next-1')
    expect(queue.dequeue()).toBe('next-2')
    expect(queue.dequeue()).toBe('later-1')
    expect(queue.dequeue()).toBeUndefined()
  })

  it('notifies subscribers and updates frozen snapshots only on mutation', () => {
    const queue = new MessageQueue()
    const listener = vi.fn()
    queue.subscribe(listener)

    const initial = queue.getSnapshot()
    queue.enqueue('hello')
    const afterEnqueue = queue.getSnapshot()

    expect(afterEnqueue).not.toBe(initial)
    expect(Object.isFrozen(afterEnqueue)).toBe(true)
    expect(afterEnqueue).toEqual([{ kind: 'user', value: 'hello', priority: 'next' }])
    expect(listener).toHaveBeenCalledTimes(1)

    expect(queue.peek()).toBe('hello')
    expect(queue.getSnapshot()).toBe(afterEnqueue)

    expect(queue.dequeue()).toBe('hello')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(queue.getSnapshot()).toEqual([])
  })

  it('supports unsubscribe and clear', () => {
    const queue = new MessageQueue()
    const listener = vi.fn()
    const unsubscribe = queue.subscribe(listener)

    queue.enqueue('hello')
    unsubscribe()
    queue.clear()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(queue.length).toBe(0)
  })

  it('dedupes mailbox wakes by agent id', () => {
    const queue = new MessageQueue()

    queue.enqueueMailboxWake('main')
    queue.enqueueMailboxWake('main')
    queue.enqueueMailboxWake('teammate-1')

    expect(queue.getSnapshot()).toEqual([
      { kind: 'mailbox-wake', agentId: 'main', priority: 'later' },
      { kind: 'mailbox-wake', agentId: 'teammate-1', priority: 'later' },
    ])
    expect(queue.length).toBe(2)
  })

  it('orders user messages before mailbox wakes', () => {
    const queue = new MessageQueue()

    queue.enqueueMailboxWake('main')
    queue.enqueue('user prompt')

    expect(queue.dequeueItem()).toEqual({ kind: 'user', value: 'user prompt', priority: 'next' })
    expect(queue.dequeueItem()).toEqual({ kind: 'mailbox-wake', agentId: 'main', priority: 'later' })
  })
})
