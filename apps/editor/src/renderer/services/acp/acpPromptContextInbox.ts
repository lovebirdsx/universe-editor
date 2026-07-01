/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptContextInbox — a per-session queue of SelectionContexts waiting to be
 *  attached to a session's prompt input, keyed by the session's *local* id.
 *
 *  Decouples the "Add Selection to Agent Chat" command from PromptInput's mount
 *  timing: the command may target a session whose ChatBody is not mounted yet
 *  (editor mode with the session tab closed, or a session it just created), so it
 *  cannot call `WidgetHandle.addSelectionContext` directly. Instead it deposits
 *  the contexts here and opens/focuses the chat; PromptInput drains its own
 *  session's inbox on mount and reacts to `onDidDeposit` while mounted, so the
 *  hand-off survives the not-mounted → mounted transition without being lost.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '@universe-editor/platform'
import type { SelectionContext } from './promptContext.js'

class AcpPromptContextInboxImpl {
  private readonly _map = new Map<string, SelectionContext[]>()
  private readonly _onDidDeposit = new Emitter<string>()
  /** Fires with the session id whenever contexts are deposited for it. */
  readonly onDidDeposit: Event<string> = this._onDidDeposit.event

  /** Queue contexts for a session. No-op for an empty list. */
  deposit(sessionId: string, contexts: readonly SelectionContext[]): void {
    if (contexts.length === 0) return
    const list = this._map.get(sessionId) ?? []
    list.push(...contexts)
    this._map.set(sessionId, list)
    this._onDidDeposit.fire(sessionId)
  }

  /** Remove and return everything queued for a session (empty array if none). */
  drain(sessionId: string): readonly SelectionContext[] {
    const list = this._map.get(sessionId)
    if (!list || list.length === 0) return []
    this._map.delete(sessionId)
    return list
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpPromptContextInbox = new AcpPromptContextInboxImpl()
