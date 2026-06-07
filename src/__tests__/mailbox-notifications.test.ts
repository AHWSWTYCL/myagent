import { afterEach, describe, expect, it, vi } from 'vitest'
import { Mailbox } from '../mailbox/mailbox.js'

const testIds = new Set<string>()

function id(name: string): string {
  const value = `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  testIds.add(value)
  return value
}

function send(to: string) {
  return Mailbox.send({
    from: 'sender',
    to,
    subject: 'subject',
    kind: 'status',
    body: 'body',
  })
}

afterEach(() => {
  for (const agentId of testIds) Mailbox.destroy(agentId)
  testIds.clear()
})

describe('Mailbox notifications', () => {
  it('notifies subscribers after mail is written', () => {
    const agentId = id('notify')
    const listener = vi.fn(() => {
      expect(Mailbox.list(agentId)).toHaveLength(1)
    })

    const unsubscribe = Mailbox.subscribe(agentId, listener)
    const mail = send(agentId)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(mail)
    unsubscribe()
  })

  it('does not notify subscribers for other recipients', () => {
    const target = id('target')
    const other = id('other')
    const listener = vi.fn()

    const unsubscribe = Mailbox.subscribe(target, listener)
    send(other)

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('stops notifying after unsubscribe', () => {
    const agentId = id('unsubscribe')
    const listener = vi.fn()

    const unsubscribe = Mailbox.subscribe(agentId, listener)
    unsubscribe()
    send(agentId)

    expect(listener).not.toHaveBeenCalled()
  })

  it('waits for mail to arrive', async () => {
    const agentId = id('wait')
    const waiting = Mailbox.waitForMail(agentId)

    send(agentId)

    await expect(waiting).resolves.toBeUndefined()
  })

  it('resolves when aborted', async () => {
    const agentId = id('abort')
    const controller = new AbortController()
    const waiting = Mailbox.waitForMail(agentId, controller.signal)

    controller.abort()

    await expect(waiting).resolves.toBeUndefined()
  })
})
