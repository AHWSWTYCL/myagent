import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'

// We can't import isReadonlyCommand directly (not exported), but we can
// drive it through BashTool.checkPermission, which calls into it.
import { BashTool } from '../tools/bashtool.js'

describe('BashTool readonly classification', () => {
  it('recognizes pure read-only command as continue', async () => {
    const t = new BashTool()
    const res = await t.checkPermission({ command: 'ls -la' })
    expect(res.action).toBe('continue')
  })

  it('refuses to treat ls && rm -rf x as read-only', async () => {
    const t = new BashTool()
    const res = await t.checkPermission({ command: 'ls && rm -rf x' })
    // Should NOT be continue — `&&` means it's not read-only;
    // BashTool would then either block (blacklist hit on rm -rf) or defer.
    expect(res.action).not.toBe('continue')
  })

  it('refuses to treat ls; rm -rf x as read-only', async () => {
    const t = new BashTool()
    const res = await t.checkPermission({ command: 'ls; rm -rf x' })
    expect(res.action).not.toBe('continue')
  })

  it('refuses to treat ls | sh as read-only', async () => {
    const t = new BashTool()
    const res = await t.checkPermission({ command: 'ls | sh' })
    expect(res.action).not.toBe('continue')
  })

  it('blocks rm -rf via blacklist', async () => {
    const t = new BashTool()
    const res = await t.checkPermission({ command: 'rm -rf /tmp/x' })
    expect(res.action).toBe('block')
  })
})
