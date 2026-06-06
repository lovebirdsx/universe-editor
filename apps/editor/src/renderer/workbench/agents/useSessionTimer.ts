import { useEffect, useState } from 'react'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'

export function useSessionTimer(session: IAcpSession): number {
  const accumulated = useObservable(session.accumulatedRunningMs)
  const startedAt = useObservable(session.runningStartedAt)
  // Only used to trigger a re-render each second. Date.now() is read fresh at
  // render time so there is no stale-timestamp glitch on the first render after
  // startedAt is set.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (startedAt === undefined) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (startedAt !== undefined) {
    return accumulated + Math.max(0, Date.now() - startedAt)
  }
  return accumulated
}

export function formatRunningTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) {
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
