/*---------------------------------------------------------------------------------------------
 *  AcpElicitationDraftCache — in-memory store for the unsubmitted
 *  ElicitationCard input values, keyed by (sessionId, requestKey) where the
 *  requestKey is the elicitation's toolCallId when present, else a hash of the
 *  request message. Switching editor tabs or sessions and coming back restores
 *  the in-progress form instead of clearing it. Esc / 关闭 does NOT clear the
 *  draft — closing is not answering, and the user may reopen the same
 *  elicitation by switching back.
 *--------------------------------------------------------------------------------------------*/

/** In-progress card input — numbers stay raw strings until submit conversion. */
export type ElicitationDraftValues = Record<string, string | boolean | string[] | undefined>

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
 * Distinct (session, request) drafts kept at once. Each holds one card's worth of form
 * text, so the entries are individually small — the cap is here to bound the *count*,
 * since nothing else ever removed an entry for a session the user simply abandoned.
 */
const MAX_DRAFT_ENTRIES = 32

class AcpElicitationDraftCacheImpl {
  private readonly _map = new Map<string, ElicitationDraftValues>()

  private key(sessionId: string, requestKey: string): string {
    return `${sessionId} ${requestKey}`
  }

  save(sessionId: string, requestKey: string, values: ElicitationDraftValues): void {
    const key = this.key(sessionId, requestKey)
    // Re-inserting refreshes recency, so the entry dropped at the cap is the one the
    // user was least recently filling in.
    this._map.delete(key)
    this._map.set(key, values)
    while (this._map.size > MAX_DRAFT_ENTRIES) {
      const oldest = this._map.keys().next()
      if (oldest.done) break
      this._map.delete(oldest.value)
    }
  }

  load(sessionId: string, requestKey: string): ElicitationDraftValues | undefined {
    return this._map.get(this.key(sessionId, requestKey))
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
