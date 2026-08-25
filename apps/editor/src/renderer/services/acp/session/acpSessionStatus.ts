/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Display-status derivation: folds a session's `status` together with its
 *  pending elicitation / permission and background-task count into a single
 *  value that the cross-window switcher and the window title both render.
 *  The extra `'ask'` value surfaces "waiting for the user to choose or answer"
 *  — a state ACP models as a separate observable rather than a status, so we
 *  derive it here instead of bloating the core `AcpSessionStatus` state
 *  machine. Likewise `'background'` surfaces "the turn settled but
 *  `run_in_background` tasks are still executing on the agent" — the prompt
 *  RPC is done, so the core status reads `idle`, yet killing the session would
 *  kill real work. Precedence: closed (terminal) > ask > core status >
 *  background (idle only).
 *--------------------------------------------------------------------------------------------*/

import type { IReader } from '@universe-editor/platform'
import type { AcpSessionStatus, IAcpSession } from './acpSession.js'

export type AcpSessionDisplayStatus = AcpSessionStatus | 'ask' | 'background'

/**
 * True when a resident session is still usable — i.e. `status === 'closed'` does
 * NOT mean "gone" for it.
 *
 * The idle reaper (`acp.idleProcessTimeoutMs`) stops an idle agent process to
 * free memory, which seals the session's status to `'closed'` while leaving the
 * session object, its timeline and its resumable durable id fully intact
 * ({@link IAcpSession.isDormant}). Such a session must be reused and woken, not
 * treated as dead: duplicating it would build a second session for the same
 * durable id, and hiding its live badges would make the row look closed.
 *
 * Use this anywhere the old `status !== 'closed'` test meant "this session is
 * still worth talking to". Pass the autorun `IReader` to keep the subscription
 * live; omit it for a one-shot snapshot.
 */
export function isResidentLive(session: IAcpSession, r?: IReader): boolean {
  const status = r ? session.status.read(r) : session.status.get()
  if (status !== 'closed') return true
  return r ? session.isDormant.read(r) : session.isDormant.get()
}

/**
 * Derive the display status. When an elicitation or permission is pending (and
 * the session is not closed) the session is waiting on the user → `'ask'`;
 * when the core status is idle but background tasks are still in flight →
 * `'background'`; otherwise it mirrors `session.status`. Pass the autorun
 * `IReader` to keep the subscription live; omit it for a one-shot snapshot.
 */
export function computeSessionDisplayStatus(
  session: IAcpSession,
  r?: IReader,
): AcpSessionDisplayStatus {
  const status = r ? session.status.read(r) : session.status.get()
  const pendingElicitation = r
    ? session.pendingElicitation.read(r)
    : session.pendingElicitation.get()
  const pendingPermission = r ? session.pendingPermission.read(r) : session.pendingPermission.get()
  if (
    status !== 'closed' &&
    (pendingElicitation !== undefined || pendingPermission !== undefined)
  ) {
    return 'ask'
  }
  const backgroundTasks = r
    ? session.backgroundTaskCount.read(r)
    : session.backgroundTaskCount.get()
  if (status === 'idle' && backgroundTasks > 0) return 'background'
  return status
}
