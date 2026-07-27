/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptTextInbox — a per-session queue of plain-text snippets waiting to be
 *  appended to a session's prompt input, keyed by the session's *local* id.
 *
 *  The text sibling of AcpPromptContextInbox: some commands (e.g. Git Graph's
 *  "Send to Agent Chat") want to drop free-form text into a prompt rather than a
 *  ranged SelectionContext chip. Same mount-timing decoupling applies — the
 *  target session's PromptInput may not be mounted yet — so the command deposits
 *  here and opens/focuses the chat; PromptInput drains its own session's inbox on
 *  mount and reacts to `onDidDeposit` while mounted.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '@universe-editor/platform'

class AcpPromptTextInboxImpl {
  private readonly _map = new Map<string, string[]>()
  private readonly _onDidDeposit = new Emitter<string>()
  /** Fires with the session id whenever text is deposited for it. */
  readonly onDidDeposit: Event<string> = this._onDidDeposit.event

  /** Queue a text snippet for a session. No-op for empty/blank text. */
  deposit(sessionId: string, text: string): void {
    if (text.trim().length === 0) return
    const list = this._map.get(sessionId) ?? []
    list.push(text)
    this._map.set(sessionId, list)
    this._onDidDeposit.fire(sessionId)
  }

  /** Remove and return everything queued for a session (empty array if none). */
  drain(sessionId: string): readonly string[] {
    const list = this._map.get(sessionId)
    if (!list || list.length === 0) return []
    this._map.delete(sessionId)
    return list
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpPromptTextInbox = new AcpPromptTextInboxImpl()
