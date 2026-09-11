/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptCancelledDraftStash — holds the full draft of the most recently
 *  submitted prompt per session, so cancelling a turn before any response
 *  arrives can restore it into the input box (Claude Code CLI parity).
 *  Unlike AcpPromptDraftCache (unsent draft, survives until submit), entries
 *  here are one-shot: drained on cancel, cleared on successful completion.
 *
 *  Bounded by session count rather than by bytes: an entry normally lives for the
 *  few seconds between submit and the first response, and the cap only ever binds
 *  when sessions are abandoned mid-flight. `measureDraftBytes` is shared with the
 *  draft cache so the two report the same accounting for the same value.
 *--------------------------------------------------------------------------------------------*/

import { BoundedCache } from '../../memory/boundedCache.js'
import { measureDraftBytes, type AcpPromptDraft } from './acpPromptDraftCache.js'

export const MAX_CANCELLED_DRAFTS = 4

class AcpPromptCancelledDraftStashImpl {
  private readonly _cache = new BoundedCache<AcpPromptDraft>(
    measureDraftBytes,
    MAX_CANCELLED_DRAFTS,
    Number.MAX_SAFE_INTEGER,
  )

  save(sessionId: string, draft: AcpPromptDraft): void {
    this._cache.set(sessionId, draft)
  }

  /** Take the stashed draft out (single consume); subsequent calls return undefined. */
  drain(sessionId: string): AcpPromptDraft | undefined {
    const draft = this._cache.get(sessionId)
    if (draft !== undefined) {
      this._cache.delete(sessionId)
    }
    return draft
  }

  clear(sessionId: string): void {
    this._cache.delete(sessionId)
  }

  stats(): { entries: number; bytes: number } {
    const stats = this._cache.stats()
    return { entries: stats.entries, bytes: stats.bytes }
  }

  /** Drop every stashed draft, returning the bytes released. */
  release(): number {
    return this._cache.clear()
  }

  _resetForTests(): void {
    this._cache.clear()
  }
}

export const AcpPromptCancelledDraftStash = new AcpPromptCancelledDraftStashImpl()
