/*---------------------------------------------------------------------------------------------
 *  AcpElicitationDraftCache — in-memory store for the unsubmitted
 *  ElicitationCard input values, keyed by (sessionId, requestKey) where the
 *  requestKey is the elicitation's toolCallId when present, else a hash of the
 *  request message. Mirrors AcpQuestionDraftCache so switching editor tabs or
 *  sessions and coming back restores the in-progress form instead of clearing
 *  it. Esc / 关闭 does NOT clear the draft — closing is not answering, and the
 *  user may reopen the same elicitation by switching back.
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

class AcpElicitationDraftCacheImpl {
  private readonly _map = new Map<string, ElicitationDraftValues>()

  private key(sessionId: string, requestKey: string): string {
    return `${sessionId} ${requestKey}`
  }

  save(sessionId: string, requestKey: string, values: ElicitationDraftValues): void {
    this._map.set(this.key(sessionId, requestKey), values)
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
