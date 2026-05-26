import React from 'react'
import { Text } from 'ink'

interface Props {
  /** When true, text reads "(Ctrl+O to collapse)" instead of "(Ctrl+O to expand)". */
  expanded?: boolean
}

/**
 * Claude Code style keyboard hint rendered after a collapsed summary.
 *
 * In collapsed mode:
 *   Read 3 files, Searched 2 patterns (ctrl+o to expand)
 *
 * In expanded mode:
 *   Read 3 files, Searched 2 patterns (ctrl+o to collapse)
 *
 * Wraps in <Text dimColor> so it blends into the background.
 */
export function CtrlOToExpand({ expanded }: Props) {
  return (
    <Text color="gray" dimColor>
      {' '}(Ctrl+O to {expanded ? 'collapse' : 'expand'})
    </Text>
  )
}
