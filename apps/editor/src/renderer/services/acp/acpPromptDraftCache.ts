/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptDraftCache — in-memory store for the unsent PromptInput draft,
 *  keyed by session id. Mirrors AcpChatViewStateCache so switching editor tabs
 *  or sessions and coming back restores the draft instead of clearing it. The
 *  draft keeps both the plain text and the recorded @-mentions, so a restored
 *  draft still serializes its mentions into resource_links on submit.
 *--------------------------------------------------------------------------------------------*/

import type { PromptMention } from './promptMentions.js'
import type { SelectionContext } from './promptContext.js'

export interface AcpPromptDraft {
  readonly text: string
  readonly mentions: readonly PromptMention[]
  readonly contexts?: readonly SelectionContext[]
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
