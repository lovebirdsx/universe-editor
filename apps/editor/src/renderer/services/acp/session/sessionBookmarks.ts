/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session bookmarks: each ACP session owns its own ten numbered slots (0-9) that
 *  pin to a timeline slot inside that session's editor — the session-editor
 *  counterpart to the numbered-bookmarks extension's line bookmarks, but a session
 *  has no "line": its smallest addressable unit is a timeline slot key (`m:<id>` /
 *  `t:<id>`). A numbered bookmark is unique WITHIN a session: setting slot 3 on
 *  another card in the same session moves bookmark 3 there, but slot 3 in a
 *  different session is independent. Slots are also independent of the document
 *  bookmarks.
 *--------------------------------------------------------------------------------------------*/

export const SLOT_COUNT = 10

/** Ten slots for one session; index = bookmark number, value = slot key or null. */
export type SessionSlots = Array<string | null>

export function emptySlots(): SessionSlots {
  return new Array<string | null>(SLOT_COUNT).fill(null)
}

/** One session's persisted slots, tagged with the (durable) session id. */
export interface PersistedSession {
  readonly sessionId: string
  readonly slots: SessionSlots
}

/** Per-session numbered slots: sessionId → ten slots (bookmark number → slot key). */
export class SessionBookmarkStore {
  private readonly sessions = new Map<string, SessionSlots>()

  get(sessionId: string, slot: number): string | null {
    return this.sessions.get(sessionId)?.[slot] ?? null
  }

  /**
   * Toggle bookmark `slot` in `sessionId` at `slotKey`: clears it when the slot
   * already points at exactly this key, otherwise (re)assigns the slot here.
   * Returns the resulting slot key, or null when cleared.
   */
  toggle(sessionId: string, slot: number, slotKey: string): string | null {
    const slots = this._slotsFor(sessionId)
    if (slots[slot] === slotKey) {
      slots[slot] = null
      this._pruneIfEmpty(sessionId, slots)
      return null
    }
    slots[slot] = slotKey
    return slotKey
  }

  clearSlot(sessionId: string, slot: number): void {
    const slots = this.sessions.get(sessionId)
    if (!slots) return
    slots[slot] = null
    this._pruneIfEmpty(sessionId, slots)
  }

  /**
   * Re-key each session's id through `resolve` (local id → durable id). Used
   * before persistence so a bookmark set before the agent issued its durable id
   * is stored under the durable id and survives a restart. When two ids collapse
   * onto the same durable id, non-empty slots from the source fill empty slots in
   * the target. Returns whether anything actually changed.
   */
  normalize(resolve: (sessionId: string) => string): boolean {
    let changed = false
    for (const [sessionId, slots] of [...this.sessions]) {
      const next = resolve(sessionId)
      if (next === sessionId) continue
      changed = true
      this.sessions.delete(sessionId)
      const target = this.sessions.get(next)
      if (!target) {
        this.sessions.set(next, slots)
        continue
      }
      for (let n = 0; n < SLOT_COUNT; n++) {
        if (target[n] === null && slots[n] !== null) target[n] = slots[n] ?? null
      }
    }
    return changed
  }

  /** Drop every slot in `sessionId` (session closed / removed). Returns whether
   *  anything was cleared, so callers can skip a needless persist. */
  clearSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  /** `[slot, slotKey]` pairs set in `sessionId`, in slot order. */
  forSession(sessionId: string): Array<[number, string]> {
    const slots = this.sessions.get(sessionId)
    if (!slots) return []
    const out: Array<[number, string]> = []
    for (let n = 0; n < SLOT_COUNT; n++) {
      const key = slots[n]
      if (key !== null && key !== undefined) out.push([n, key])
    }
    return out
  }

  /** True when `sessionId` has no slot set. */
  isEmptyForSession(sessionId: string): boolean {
    return this.forSession(sessionId).length === 0
  }

  /** Snapshot for persistence: one entry per non-empty session. */
  serialize(): PersistedSession[] {
    const out: PersistedSession[] = []
    for (const [sessionId, slots] of this.sessions) {
      if (slots.some((k) => k !== null)) out.push({ sessionId, slots: slots.slice() })
    }
    return out
  }

  /** Replace all sessions from a persisted snapshot, tolerating malformed entries. */
  load(data: unknown): void {
    this.sessions.clear()
    if (!Array.isArray(data)) return
    for (const entry of data) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as PersistedSession).sessionId !== 'string' ||
        !Array.isArray((entry as PersistedSession).slots)
      ) {
        continue
      }
      const rawSlots = (entry as PersistedSession).slots
      const slots = emptySlots()
      for (let n = 0; n < SLOT_COUNT; n++) {
        const key = rawSlots[n]
        if (typeof key === 'string') slots[n] = key
      }
      if (slots.some((k) => k !== null)) {
        this.sessions.set((entry as PersistedSession).sessionId, slots)
      }
    }
  }

  private _slotsFor(sessionId: string): SessionSlots {
    let slots = this.sessions.get(sessionId)
    if (!slots) {
      slots = emptySlots()
      this.sessions.set(sessionId, slots)
    }
    return slots
  }

  private _pruneIfEmpty(sessionId: string, slots: SessionSlots): void {
    if (slots.every((k) => k === null)) this.sessions.delete(sessionId)
  }
}
