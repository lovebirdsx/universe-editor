/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptDraftCache — in-memory store for the unsent PromptInput draft,
 *  keyed by session id. Mirrors AcpChatViewStateCache so switching editor tabs
 *  or sessions and coming back restores the draft instead of clearing it. The
 *  draft keeps the plain text plus the range-tracked @/# references (PlacedRef),
 *  so a restored draft rebuilds its reference pills and still serializes them on
 *  submit.
 *
 *  Bounded, because a draft is not small: an attached image is a base64 string the
 *  prompt UI allows up to `acp.prompt.image.maxSizeMB` (5MB by default), and with no
 *  cap one entry per session ever touched kept every one of them resident for the
 *  life of the window.
 *--------------------------------------------------------------------------------------------*/

import { BoundedCache } from '../../memory/boundedCache.js'
import type { SelectionContext } from '../promptContext.js'
import type { PromptImage } from '../promptImage.js'
import type { PlacedRef } from '../promptRef.js'

export interface AcpPromptDraft {
  readonly text: string
  /** Range-tracked @/# references embedded in `text` (replaces old mentions+contextRefs). */
  readonly refs?: readonly PlacedRef[]
  readonly contexts?: readonly SelectionContext[]
  readonly images?: readonly PromptImage[]
  readonly caret?: number
}

export const MAX_DRAFT_SESSIONS = 8
export const MAX_DRAFT_BYTES = 32 * 1024 * 1024

/**
 * UTF-16 bytes of a draft. The single measure used for admission, eviction and the
 * release report — a second definition would let the reported saving disagree with the
 * heap, which is the one thing the memory log cannot afford.
 */
export function measureDraftBytes(draft: AcpPromptDraft): number {
  let bytes = draft.text.length * 2
  for (const image of draft.images ?? []) bytes += image.dataBase64.length * 2
  for (const context of draft.contexts ?? []) bytes += context.text.length * 2
  for (const placed of draft.refs ?? []) {
    bytes += (placed.ref.label.length + placed.ref.uri.length) * 2
  }
  return bytes
}

class AcpPromptDraftCacheImpl {
  private readonly _cache = new BoundedCache<AcpPromptDraft>(
    measureDraftBytes,
    MAX_DRAFT_SESSIONS,
    MAX_DRAFT_BYTES,
    (sessionId) => this._pinned.has(sessionId),
  )
  private readonly _pinned = new Map<string, number>()

  save(sessionId: string, draft: AcpPromptDraft): void {
    this._cache.set(sessionId, draft)
  }

  load(sessionId: string): AcpPromptDraft | undefined {
    return this._cache.get(sessionId)
  }

  clear(sessionId: string): void {
    this._cache.delete(sessionId)
  }

  /**
   * Exempt a session from eviction while its input box is on screen. Without this the
   * watermark could drop the draft the user is about to return to, purely because they
   * happened to type in another session more recently.
   *
   * Reference counted: a layout switch can briefly mount two `PromptInput`s for the same
   * session, and the first unmount would otherwise unpin a box that is still on screen.
   */
  pin(sessionId: string): void {
    this._pinned.set(sessionId, (this._pinned.get(sessionId) ?? 0) + 1)
  }

  unpin(sessionId: string): void {
    const count = this._pinned.get(sessionId)
    if (count === undefined) return
    if (count <= 1) this._pinned.delete(sessionId)
    else this._pinned.set(sessionId, count - 1)
  }

  /** Bytes held right now, for the memory-pressure waterline. */
  stats(): { entries: number; bytes: number } {
    const stats = this._cache.stats()
    return { entries: stats.entries, bytes: stats.bytes }
  }

  releaseTo(maxBytes: number): number {
    return this._cache.releaseTo(maxBytes)
  }

  _resetForTests(): void {
    this._cache.clear()
    this._pinned.clear()
  }
}

export const AcpPromptDraftCache = new AcpPromptDraftCacheImpl()
