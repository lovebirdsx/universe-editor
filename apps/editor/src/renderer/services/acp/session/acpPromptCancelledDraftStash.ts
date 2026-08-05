/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptCancelledDraftStash — holds the full draft of the most recently
 *  submitted prompt per session, so cancelling a turn before any response
 *  arrives can restore it into the input box (Claude Code CLI parity).
 *  Unlike AcpPromptDraftCache (unsent draft, survives until submit), entries
 *  here are one-shot: drained on cancel, cleared on successful completion.
 *--------------------------------------------------------------------------------------------*/

import type { AcpPromptDraft } from './acpPromptDraftCache.js'

class AcpPromptCancelledDraftStashImpl {
  private readonly _map = new Map<string, AcpPromptDraft>()

  save(sessionId: string, draft: AcpPromptDraft): void {
    this._map.set(sessionId, draft)
  }

  /** Take the stashed draft out (single consume); subsequent calls return undefined. */
  drain(sessionId: string): AcpPromptDraft | undefined {
    const draft = this._map.get(sessionId)
    if (draft !== undefined) {
      this._map.delete(sessionId)
    }
    return draft
  }

  clear(sessionId: string): void {
    this._map.delete(sessionId)
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpPromptCancelledDraftStash = new AcpPromptCancelledDraftStashImpl()
