/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Display-status derivation: folds a session's `status` together with its
 *  pending question / permission into a single value that the cross-window
 *  switcher and the window title both render. The extra `'ask'` value surfaces
 *  "waiting for the user to choose or answer" — a state ACP models as a separate
 *  observable rather than a status, so we derive it here instead of bloating the
 *  core `AcpSessionStatus` state machine.
 *--------------------------------------------------------------------------------------------*/

import type { IReader } from '@universe-editor/platform'
import type { AcpSessionStatus, IAcpSession } from './acpSession.js'

export type AcpSessionDisplayStatus = AcpSessionStatus | 'ask'

/**
 * Derive the display status. When a question or permission is pending (and the
 * session is not closed) the session is waiting on the user → `'ask'`; otherwise
 * it mirrors `session.status`. Pass the autorun `IReader` to keep the
 * subscription live; omit it for a one-shot snapshot.
 */
export function computeSessionDisplayStatus(
  session: IAcpSession,
  r?: IReader,
): AcpSessionDisplayStatus {
  const status = r ? session.status.read(r) : session.status.get()
  const pendingQuestion = r ? session.pendingQuestion.read(r) : session.pendingQuestion.get()
  const pendingPermission = r ? session.pendingPermission.read(r) : session.pendingPermission.get()
  if (status !== 'closed' && (pendingQuestion !== undefined || pendingPermission !== undefined)) {
    return 'ask'
  }
  return status
}
