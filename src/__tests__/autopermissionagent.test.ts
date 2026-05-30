import { describe, it, expect, vi } from 'vitest'

// AutoPermissionAgent should fail-CLOSED on API errors and on unparseable
// responses. Regression test for the previous fail-open behavior.
import { AutoPermissionAgent } from '../hooks/autopermissionagent.js'

describe('AutoPermissionAgent', () => {
  it('returns "no" when the API throws', async () => {
    const fakeClient = {
      messages: { create: vi.fn().mockRejectedValue(new Error('network')) },
    } as any
    const agent = new AutoPermissionAgent(fakeClient)
    expect(await agent.decide('rm something')).toBe('no')
  })

  it('returns "no" when response has no JSON object', async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'sure why not' }],
        }),
      },
    } as any
    const agent = new AutoPermissionAgent(fakeClient)
    expect(await agent.decide('rm something')).toBe('no')
  })

  it('returns "yes" only on explicit allow', async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"decision":"allow"}' }],
        }),
      },
    } as any
    const agent = new AutoPermissionAgent(fakeClient)
    expect(await agent.decide('ls')).toBe('yes')
  })

  it('returns "no" on explicit block', async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"decision":"block","reason":"x"}' }],
        }),
      },
    } as any
    const agent = new AutoPermissionAgent(fakeClient)
    expect(await agent.decide('rm -rf')).toBe('no')
  })
})
