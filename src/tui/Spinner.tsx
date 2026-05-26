import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'

const SPINNER_FRAMES = ['✢', '✳', '✶', '✻', '✽']

const VERBS = [
  'Thinking', 'Pondering', 'Cogitating', 'Synthesizing', 'Hatching',
  'Brewing', 'Mulling', 'Cooking', 'Considering', 'Reasoning',
  'Working', 'Crunching', 'Plotting', 'Reviewing',
]

function pickVerb(seed: number): string {
  return VERBS[seed % VERBS.length]
}

interface Props {
  /** Whether the spinner should animate. */
  active: boolean
  /** Optional custom label that replaces the verb (e.g. for tool name). */
  label?: string
  /** Elapsed seconds since activity started. */
  elapsedSec: number
  /** Tint of the spinner glyph + label (defaults to cyan). */
  color?: string
  /** Whether to show "esc to interrupt" hint at the end. */
  showInterruptHint?: boolean
}

/**
 * Claude Code style spinner: rotating glyph, action verb, elapsed time, and
 * a dim "esc to interrupt" hint. Verb cycles every 4s while active so users
 * see life on long-running calls.
 */
export function Spinner({ active, label, elapsedSec, color = 'cyan', showInterruptHint = true }: Props) {
  const [frame, setFrame] = useState(0)
  const verbSeedRef = useRef(Math.floor(Math.random() * VERBS.length))
  const [verbTick, setVerbTick] = useState(0)

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 120)
    return () => clearInterval(t)
  }, [active])

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setVerbTick(v => v + 1), 4000)
    return () => clearInterval(t)
  }, [active])

  if (!active) return null

  const verb = label ?? pickVerb(verbSeedRef.current + verbTick)
  const glyph = SPINNER_FRAMES[frame]

  return (
    <Box>
      <Text color={color as any}>{glyph} </Text>
      <Text color={color as any}>{verb}…</Text>
      <Text color="gray" dimColor>{` (${elapsedSec}s${showInterruptHint ? ' · esc to interrupt' : ''})`}</Text>
    </Box>
  )
}

export { SPINNER_FRAMES }
