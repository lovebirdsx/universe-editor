/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptReplaceInbox — a per-session slot holding a draft that should
 *  *replace* the prompt input's whole content, keyed by the session's *local* id.
 *
 *  The replace-semantics sibling of AcpPromptTextInbox (which appends): the
 *  Rewind command backfills the rewound user turn's text so the user can edit it
 *  and retry ("edit-and-retry"). Unlike an append, this overwrites the draft —
 *  the conversation past that turn is gone, so its text belongs in the input, not
 *  after whatever was there. Same mount-timing decoupling: the command deposits
 *  here and reveals the chat; PromptInput drains on mount and reacts to
 *  `onDidDeposit` while mounted. Only the latest deposit survives (last wins).
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '@universe-editor/platform'
import type { SelectionContext } from '../promptContext.js'

export interface AcpPromptReplacement {
  readonly text: string
  readonly contexts: readonly SelectionContext[]
}

class AcpPromptReplaceInboxImpl {
  private readonly _map = new Map<string, AcpPromptReplacement>()
  private readonly _onDidDeposit = new Emitter<string>()
  /** Fires with the session id whenever replacement text is deposited for it. */
  readonly onDidDeposit: Event<string> = this._onDidDeposit.event

  /** Set the replacement draft for a session (last deposit wins). */
  deposit(sessionId: string, replacement: AcpPromptReplacement): void {
    this._map.set(sessionId, replacement)
    this._onDidDeposit.fire(sessionId)
  }

  /** Remove and return the queued replacement for a session (undefined if none). */
  drain(sessionId: string): AcpPromptReplacement | undefined {
    const replacement = this._map.get(sessionId)
    if (replacement === undefined) return undefined
    this._map.delete(sessionId)
    return replacement
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpPromptReplaceInbox = new AcpPromptReplaceInboxImpl()
