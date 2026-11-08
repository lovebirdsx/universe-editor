/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared "an agent session needs the user" edge detector. Desktop OS
 *  notifications and the phone bridge consume the same signal so both ends
 *  agree on when a session is waiting, finished, or failed.
 *
 *  The signal deliberately does not read `acp.notifications.enabled`: that
 *  setting only gates the PC's OS toasts, while the phone has its own
 *  per-device switch. Consumers apply their own gate.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  autorun,
  type Event,
  type IDisposable,
  type IObservable,
} from '@universe-editor/platform'
import { computeSessionDisplayStatus, isTurnDisplayStatus } from './acpSessionStatus.js'
import type { IAcpSession } from './acpSession.js'

export type AgentAttentionKind = 'permission' | 'question' | 'completed' | 'errored'

export interface AgentAttentionEvent {
  readonly kind: AgentAttentionKind
  readonly session: IAcpSession
}

export interface AgentAttentionSignal {
  onDidAttention: Event<AgentAttentionEvent>
  dispose(): void
}

/**
 * Delay before a completion event is emitted. The status derivation folds
 * several signals (core status, background tasks, autonomous activity) that
 * arrive as separate pushes, and the fork's level snapshot can land one tick
 * after the edge — a transient `running → idle → running` would otherwise
 * report a completion that never happened. Short enough to stay invisible.
 */
export const COMPLETION_ANNOUNCE_DELAY_MS = 250

export interface AgentAttentionSignalOptions {
  readonly completionDelayMs?: number
}

/**
 * Watch a session collection and emit rising edges:
 * - `permission`: a manual permission card appeared (auto-resolving plan cards
 *   need no attention);
 * - `question`: an elicitation appeared;
 * - `completed`: a turn settled to `idle` and stayed there for the debounce;
 * - `errored`: the status became `errored`.
 */
export function createAgentAttentionSignal(
  sessions: IObservable<readonly IAcpSession[]>,
  options: AgentAttentionSignalOptions = {},
): AgentAttentionSignal {
  const completionDelayMs = options.completionDelayMs ?? COMPLETION_ANNOUNCE_DELAY_MS
  const emitter = new Emitter<AgentAttentionEvent>()
  const perSession = new Map<string, IDisposable>()
  let disposed = false

  const rootWatcher = autorun((r) => {
    const list = sessions.read(r)
    const present = new Set(list.map((session) => session.id))
    for (const session of list) {
      if (!perSession.has(session.id)) {
        perSession.set(session.id, watchSession(session))
      }
    }
    for (const [id, watcher] of perSession) {
      if (present.has(id)) continue
      watcher.dispose()
      perSession.delete(id)
    }
  })

  function emit(kind: AgentAttentionKind, session: IAcpSession): void {
    if (disposed) return
    emitter.fire({ kind, session })
  }

  function watchSession(session: IAcpSession): IDisposable {
    let prevDisplay = computeSessionDisplayStatus(session)
    let permissionLatched = session.pendingPermission.get() !== undefined
    let elicitationLatched = session.pendingElicitation.get() !== undefined
    let completionAnnounced = false
    let pendingCompletion: ReturnType<typeof setTimeout> | undefined

    const cancelPendingCompletion = (): void => {
      if (pendingCompletion === undefined) return
      clearTimeout(pendingCompletion)
      pendingCompletion = undefined
    }

    const watcher = autorun((r) => {
      const display = computeSessionDisplayStatus(session, r)
      const permission = session.pendingPermission.read(r)
      const elicitation = session.pendingElicitation.read(r)

      // A card the service marked as auto-resolving counts down and continues
      // on its own, so pulling the user back would be noise.
      if (permission !== undefined && !permissionLatched && permission.autoResolve === undefined) {
        emit('permission', session)
      }
      permissionLatched = permission !== undefined

      if (elicitation !== undefined && !elicitationLatched) emit('question', session)
      elicitationLatched = elicitation !== undefined

      // Work is in flight again (a new turn, a background task the settled turn
      // left behind, or a turn parked on the user): re-arm the per-turn latch.
      if (isTurnDisplayStatus(display)) completionAnnounced = false

      // Announcing on the core status alone either fires early or swallows the
      // real finish; the edge is a TURN edge (see acpSessionStatus).
      const turnFinished = display === 'idle' && isTurnDisplayStatus(prevDisplay)
      if (turnFinished && !completionAnnounced) {
        completionAnnounced = true
        cancelPendingCompletion()
        pendingCompletion = setTimeout(() => {
          pendingCompletion = undefined
          emit('completed', session)
        }, completionDelayMs)
      } else if (display !== 'idle') {
        cancelPendingCompletion()
      }

      if (display === 'errored' && prevDisplay !== 'errored') emit('errored', session)

      prevDisplay = display
    })

    // Plain literal, not `toDisposable`: this watcher lives as long as the
    // session row and the leak tracker treats a tracked wrapper outliving its
    // creator's autorun as a leak.
    return {
      dispose: () => {
        cancelPendingCompletion()
        watcher.dispose()
      },
    }
  }

  return {
    onDidAttention: emitter.event,
    dispose: () => {
      if (disposed) return
      disposed = true
      rootWatcher.dispose()
      for (const watcher of perSession.values()) watcher.dispose()
      perSession.clear()
      emitter.dispose()
    },
  }
}
