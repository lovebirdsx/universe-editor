/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared elapsed-time helpers for timeline status cards (compaction,
 *  resurrection, sub-agent badges): a `m:ss` / `Ns` formatter plus a live
 *  stopwatch hook that ticks once a second while running and freezes at the
 *  recorded duration once settled.
 *--------------------------------------------------------------------------------------------*/

import { formatElapsed } from '@universe-editor/acp-view-model'
import { useEffect, useState } from 'react'

// Shared with the phone PWA through `@universe-editor/acp-view-model`.
export { formatElapsed }

/**
 * Live stopwatch text for a status card: while `running` (and `startedAt` is
 * known) re-renders every second with the elapsed time; once settled, freezes
 * at `durationMs`. Returns null when there is nothing meaningful to show.
 */
export function useElapsedTime(
  running: boolean,
  startedAt: number | undefined,
  durationMs: number | undefined,
): string | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running || startedAt === undefined) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [running, startedAt])
  if (durationMs !== undefined) return formatElapsed(durationMs)
  if (running && startedAt !== undefined) return formatElapsed(Math.max(0, Date.now() - startedAt))
  return null
}
