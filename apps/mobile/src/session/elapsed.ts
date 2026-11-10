import { formatElapsed } from '@universe-editor/acp-view-model'
import { useEffect, useState } from 'react'

/**
 * Live stopwatch text for the timeline activity row: ticks once a second while
 * a tool runs and freezes at the recorded span once it settles. `now` must be
 * the PC clock (`MobileClient.serverNow`) so the span lines up with the wire's
 * `startedAt` despite phone/PC clock skew.
 */
export function useElapsedTime(
  running: boolean,
  startedAt: number | undefined,
  durationMs: number | undefined,
  now: () => number,
): string | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!running || startedAt === undefined || durationMs !== undefined) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [running, startedAt, durationMs])
  if (durationMs !== undefined) return formatElapsed(durationMs)
  if (running && startedAt !== undefined) return formatElapsed(Math.max(0, now() - startedAt))
  return null
}
