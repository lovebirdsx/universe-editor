/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptDraftCache — in-memory store for the unsent PromptInput draft,
 *  keyed by session id. Mirrors AcpChatViewStateCache so switching editor tabs
 *  or sessions and coming back restores the draft instead of clearing it. The
 *  draft keeps the plain text plus the range-tracked @/# references (PlacedRef),
 *  so a restored draft rebuilds its reference pills and still serializes them on
 *  submit.
 *--------------------------------------------------------------------------------------------*/

import type { SelectionContext } from './promptContext.js'
import type { PromptImage } from './promptImage.js'
import type { PlacedRef } from './promptRef.js'

export interface AcpPromptDraft {
  readonly text: string
  /** Range-tracked @/# references embedded in `text` (replaces old mentions+contextRefs). */
  readonly refs?: readonly PlacedRef[]
  readonly contexts?: readonly SelectionContext[]
  readonly images?: readonly PromptImage[]
  readonly caret?: number
}

class AcpPromptDraftCacheImpl {
  private readonly _map = new Map<string, AcpPromptDraft>()

  save(sessionId: string, draft: AcpPromptDraft): void {
    this._map.set(sessionId, draft)
  }

  load(sessionId: string): AcpPromptDraft | undefined {
    return this._map.get(sessionId)
  }

  clear(sessionId: string): void {
    this._map.delete(sessionId)
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpPromptDraftCache = new AcpPromptDraftCacheImpl()
