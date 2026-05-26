import React, { useEffect, useState } from 'react'
import { Text } from 'ink'

export type DotStatus = 'running' | 'success' | 'error' | 'idle'

interface Props {
  /** Visual state of the dot. */
  status: DotStatus
  /**
   * Optional label shown after the dot, e.g. "Bash" / "Done".
   * When omitted, only the dot glyph is rendered.
   */
  label?: string
  /** Optional suffix in parentheses, e.g. the tool arguments. */
  suffix?: string
}

/**
 * Claude Code style status dot: a coloured ⏺ with optional label+suffix.
 *
 * Status → appearance:
 *   running  ⏺ green, pulsing bright↔dim every 600ms (flashing/glowing)
 *   success  ⏺ solid green (completed ok)
 *   error    ⏺ solid red (tool returned error)
 *   idle     ⏺ dim gray (not yet started)
 */
export function GlowingDot({ status, label, suffix }: Props) {
  const [pulse, setPulse] = useState(false)

  useEffect(() => {
    if (status !== 'running') {
      setPulse(false)
      return
    }
    const t = setInterval(() => setPulse(v => !v), 600)
    return () => clearInterval(t)
  }, [status])

  // ── Pick color + dim based on status and pulse ──────────────────────
  const color = (() => {
    switch (status) {
      case 'running': return 'green'
      case 'success': return 'green'
      case 'error':   return 'red'
      case 'idle':    return 'gray'
    }
  })()

  // running status pulses between bright and dim
  const dim = status === 'running' ? pulse : status === 'idle'

  return (
    <Text>
      <Text color={color as any} dimColor={dim}>⏺</Text>
      {label ? <Text bold color={color as any} dimColor={dim}> {label}</Text> : null}
      {suffix ? <Text color="gray" dimColor={dim && status === 'running'}> ({suffix})</Text> : null}
    </Text>
  )
}
