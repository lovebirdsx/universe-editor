/**
 * The bookmark model: ten numbered slots (0-9) shared across the whole
 * workspace. Each slot is either empty (`null`) or pinned to one location —
 * `{ path, line }` — anywhere in the workspace. A numbered bookmark is globally
 * unique: setting slot 3 in another file moves bookmark 3 there, exactly like
 * the original Delphi/Numbered Bookmarks behavior. Only the line is tracked
 * (no column), and `path` is a document key (see {@link uriToKey}).
 */

export const SLOT_COUNT = 10

export interface Bookmark {
  /** Document key (forward-slashed path, see {@link uriToKey}). */
  readonly path: string
  /** 0-based line. */
  line: number
}

export type Slots = Array<Bookmark | null>

export function emptySlots(): Slots {
  return new Array<Bookmark | null>(SLOT_COUNT).fill(null)
}

/** Ten workspace-global slots; index = bookmark number, value = location or null. */
export class BookmarkStore {
  private slots: Slots = emptySlots()

  get(slot: number): Bookmark | null {
    return this.slots[slot] ?? null
  }

  /**
   * Toggle bookmark `slot` at `path`/`line`: clears it when the slot already
   * points at exactly this location, otherwise (re)assigns the slot here. Returns
   * the resulting bookmark, or null when cleared.
   */
  toggle(slot: number, path: string, line: number): Bookmark | null {
    const current = this.slots[slot]
    if (current && current.path === path && current.line === line) {
      this.slots[slot] = null
      return null
    }
    const next: Bookmark = { path, line }
    this.slots[slot] = next
    return next
  }

  clearSlot(slot: number): void {
    this.slots[slot] = null
  }

  clearAll(): void {
    this.slots = emptySlots()
  }

  /** `[slot, line]` pairs that live in `path`, sorted by line. */
  forPath(path: string): Array<[number, number]> {
    const out: Array<[number, number]> = []
    for (let n = 0; n < SLOT_COUNT; n++) {
      const b = this.slots[n]
      if (b && b.path === path) out.push([n, b.line])
    }
    out.sort((a, b) => a[1] - b[1])
    return out
  }

  /** Every set bookmark as `[slot, bookmark]`, in slot order. */
  all(): Array<[number, Bookmark]> {
    const out: Array<[number, Bookmark]> = []
    for (let n = 0; n < SLOT_COUNT; n++) {
      const b = this.slots[n]
      if (b) out.push([n, b])
    }
    return out
  }

  /** True when no slot is set. */
  isEmpty(): boolean {
    return this.slots.every((b) => b === null)
  }

  /** Snapshot for persistence: a fixed-length array of locations or null. */
  serialize(): Slots {
    return this.slots.map((b) => (b ? { path: b.path, line: b.line } : null))
  }

  /** Replace all slots from a persisted snapshot, tolerating malformed entries. */
  load(data: unknown): void {
    const next = emptySlots()
    if (Array.isArray(data)) {
      for (let n = 0; n < SLOT_COUNT; n++) {
        const entry = data[n]
        if (
          entry &&
          typeof entry === 'object' &&
          typeof (entry as Bookmark).path === 'string' &&
          typeof (entry as Bookmark).line === 'number'
        ) {
          next[n] = { path: (entry as Bookmark).path, line: (entry as Bookmark).line }
        }
      }
    }
    this.slots = next
  }
}
