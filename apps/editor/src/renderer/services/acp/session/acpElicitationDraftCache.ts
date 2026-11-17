/*---------------------------------------------------------------------------------------------
 *  AcpElicitationDraftCache — in-memory store for the per-request ElicitationCard
 *  UI state (unsubmitted input values + the header fold), keyed by
 *  (sessionId, requestKey) where the requestKey is the elicitation's toolCallId
 *  when present, else a hash of the request message. Switching editor tabs or
 *  sessions and coming back restores the in-progress form and its folded/expanded
 *  state instead of resetting them. Esc / 关闭 does NOT clear the draft — closing
 *  is not answering, and the user may reopen the same elicitation by switching
 *  back.
 *--------------------------------------------------------------------------------------------*/

/** In-progress card input — numbers stay raw strings until submit conversion. */
export type ElicitationDraftValues = Record<string, string | boolean | string[] | undefined>

interface ElicitationCardState {
  values?: ElicitationDraftValues
  /** Header fold; a request without an entry starts expanded. */
  collapsed?: boolean
}

/** djb2 — stable, tiny, good enough to distinguish successive requests. */
function hashString(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** Draft key for one elicitation request: toolCallId when tied to a tool call, else the message hash. */
export function elicitationDraftKey(
  toolCallId: string | null | undefined,
  message: string,
): string {
  return toolCallId != null && toolCallId !== '' ? toolCallId : `msg:${hashString(message)}`
}

/**
 * Distinct (session, request) card states kept at once. Each holds one card's worth of
 * form text / a fold flag, so the entries are individually small — the cap is here to
 * bound the *count*, since nothing else ever removed an entry for a session the user
 * simply abandoned.
 */
const MAX_CARD_STATE_ENTRIES = 32

class AcpElicitationDraftCacheImpl {
  private readonly _map = new Map<string, ElicitationCardState>()

  private key(sessionId: string, requestKey: string): string {
    return `${sessionId} ${requestKey}`
  }

  /** Entry for a write, refreshing recency so the one dropped at the cap is the one
   *  the user was least recently interacting with. */
  private entry(sessionId: string, requestKey: string): ElicitationCardState {
    const key = this.key(sessionId, requestKey)
    const existing = this._map.get(key)
    if (existing) {
      this._map.delete(key)
      this._map.set(key, existing)
      return existing
    }
    const entry: ElicitationCardState = {}
    this._map.set(key, entry)
    while (this._map.size > MAX_CARD_STATE_ENTRIES) {
      const oldest = this._map.keys().next()
      if (oldest.done) break
      this._map.delete(oldest.value)
    }
    return entry
  }

  save(sessionId: string, requestKey: string, values: ElicitationDraftValues): void {
    this.entry(sessionId, requestKey).values = values
  }

  load(sessionId: string, requestKey: string): ElicitationDraftValues | undefined {
    return this._map.get(this.key(sessionId, requestKey))?.values
  }

  saveCollapsed(sessionId: string, requestKey: string, collapsed: boolean): void {
    this.entry(sessionId, requestKey).collapsed = collapsed
  }

  loadCollapsed(sessionId: string, requestKey: string): boolean | undefined {
    return this._map.get(this.key(sessionId, requestKey))?.collapsed
  }

  clear(sessionId: string, requestKey: string): void {
    this._map.delete(this.key(sessionId, requestKey))
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId} `
    for (const k of this._map.keys()) {
      if (k.startsWith(prefix)) this._map.delete(k)
    }
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpElicitationDraftCache = new AcpElicitationDraftCacheImpl()
