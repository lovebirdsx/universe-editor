import { useMemo } from 'react'
import { derived } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import {
  computeSessionDisplayStatus,
  isTurnInFlight,
  type AcpSessionDisplayStatus,
} from '../../services/acp/session/acpSessionStatus.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'

/**
 * Subscribe to a session's derived display status (core status folded with the
 * pending ask and the live background-task count).
 *
 * React components must go through this instead of reading
 * `session.status` directly: the core status alone reads `'idle'` while
 * `run_in_background` tasks are still executing, which makes the UI claim the
 * agent finished. See {@link computeSessionDisplayStatus}.
 */
export function useSessionDisplayStatus(session: IAcpSession): AcpSessionDisplayStatus {
  const status = useMemo(
    () =>
      derived(
        /**
         * @description agents.useSessionDisplayStatus
         */
        (r) => computeSessionDisplayStatus(session, r),
      ),
    [session],
  )
  return useObservable(status)
}

/**
 * Subscribe to "a turn is in flight" — a prompt RPC, a pending ask, or a
 * `run_in_background` task that outlived the prompt RPC. Gate turn
 * affordances (spinners, Stop buttons, "finished" signals) on this, never on
 * `session.status === 'running'`; the handshake is excluded, since there is no
 * turn to cancel yet.
 */
export function useTurnInFlight(session: IAcpSession): boolean {
  const inFlight = useMemo(
    () =>
      derived(
        /**
         * @description agents.useTurnInFlight
         */
        (r) => isTurnInFlight(session, r),
      ),
    [session],
  )
  return useObservable(inFlight)
}
