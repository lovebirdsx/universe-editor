/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptRefInbox — a per-session queue of @-mention refs waiting to be
 *  inserted into a session's prompt input, keyed by the session's *local* id.
 *
 *  The ref sibling of AcpPromptTextInbox: commands from Explorer / SCM
 *  ("Send to Agent Chat") insert the same tracked pills a file drop would,
 *  but the target session's PromptInput may not be mounted yet. Depositing here
 *  and revealing the chat lets PromptInput drain on mount (once Monaco is
 *  ready) and react to `onDidDeposit` while mounted.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '@universe-editor/platform'
import type { PromptRef } from '../promptRef.js'

class AcpPromptRefInboxImpl {
  private readonly _map = new Map<string, PromptRef[]>()
  private readonly _onDidDeposit = new Emitter<string>()
  /** Fires with the session id whenever refs are deposited for it. */
  readonly onDidDeposit: Event<string> = this._onDidDeposit.event

  /** Queue refs for a session. No-op for an empty list. */
  deposit(sessionId: string, refs: readonly PromptRef[]): void {
    if (refs.length === 0) return
    const list = this._map.get(sessionId) ?? []
    list.push(...refs)
    this._map.set(sessionId, list)
    this._onDidDeposit.fire(sessionId)
  }

  /** Remove and return everything queued for a session (empty array if none). */
  drain(sessionId: string): readonly PromptRef[] {
    const list = this._map.get(sessionId)
    if (!list || list.length === 0) return []
    this._map.delete(sessionId)
    return list
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpPromptRefInbox = new AcpPromptRefInboxImpl()
