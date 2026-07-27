/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptReplaceInbox — a per-session slot holding text that should *replace*
 *  the prompt input's whole content, keyed by the session's *local* id.
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

class AcpPromptReplaceInboxImpl {
  private readonly _map = new Map<string, string>()
  private readonly _onDidDeposit = new Emitter<string>()
  /** Fires with the session id whenever replacement text is deposited for it. */
  readonly onDidDeposit: Event<string> = this._onDidDeposit.event

  /** Set the replacement text for a session (last deposit wins). */
  deposit(sessionId: string, text: string): void {
    this._map.set(sessionId, text)
    this._onDidDeposit.fire(sessionId)
  }

  /** Remove and return the queued replacement for a session (undefined if none). */
  drain(sessionId: string): string | undefined {
    const text = this._map.get(sessionId)
    if (text === undefined) return undefined
    this._map.delete(sessionId)
    return text
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpPromptReplaceInbox = new AcpPromptReplaceInboxImpl()
