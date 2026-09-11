/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpResidentBudget — the *cross-session* ceiling on how much agent transcript
 *  content the renderer keeps resident.
 *
 *  Each AcpSession already bounds itself (acpContentLimits: replay gate + live
 *  trim), but those budgets are per session, so a window holding five resumed
 *  `claude --resume` sessions multiplied the ceiling by five and blew past the
 *  V8 pointer-cage limit — which is fixed at 4GB under pointer compression and
 *  cannot be raised with `--max-old-space-size`. This registry sums every live
 *  session's resident estimate and, when the total is over, releases content
 *  from the *least recently ingesting* sessions first: the chat the user is
 *  actively watching keeps its content, the ones idling in background tabs give
 *  theirs up.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '@universe-editor/platform'

/**
 * Ceiling for **all** sessions combined, in overhead-adjusted bytes (see
 * `VIEW_MODEL_OVERHEAD_FACTOR`) — roughly 256MB of wire content. Well clear of
 * the 4GB cage even alongside Monaco models, the extension host bridge and the
 * DOM, and far above what a single conversation needs to stay readable.
 */
export const GLOBAL_RESIDENT_BUDGET = 768 * 1024 * 1024

/** A participant in the shared budget — implemented by `AcpSession`. */
export interface IAcpResidentBudgetHolder {
  /** Stable id, for diagnostics only. */
  readonly budgetId: string
  /** Current resident estimate in overhead-adjusted bytes. */
  residentBytes(): number
  /** `Date.now()` of the last update that grew {@link residentBytes}; 0 if never. */
  lastIngestAt(): number
  /**
   * Release heavy content until `residentBytes() <= targetBytes`, returning the
   * bytes actually released (0 when there is nothing left to give). The measure
   * and the release must walk the same structures — a holder that reports bytes
   * it cannot free would keep the total over budget forever.
   */
  trimToward(targetBytes: number): number
}

export interface IAcpResidentBudget {
  register(holder: IAcpResidentBudgetHolder): IDisposable
  /** Total resident estimate across all registered holders. */
  totalBytes(): number
  /** Bring the total back under budget, trimming oldest-ingesting holders first. */
  reconcile(origin: string): void
  /**
   * Trim every holder down to `fraction` of its current estimate, oldest-ingesting
   * first, and return the bytes released. Answers a different question than
   * {@link reconcile}: not "we are over the ceiling" but "the heap as a whole is in
   * trouble", applied as the same proportional haircut wherever the total happens to
   * sit. The renderer memory watermark drives this (see `IMemoryPressureService`).
   */
  releaseFraction(fraction: number): number
}

export class AcpResidentBudget implements IAcpResidentBudget {
  private readonly _holders = new Set<IAcpResidentBudgetHolder>()
  /** Re-entrancy guard: a trim pushes observables, which can loop back here. */
  private _reconciling = false

  constructor(private readonly _budget: number = GLOBAL_RESIDENT_BUDGET) {}

  register(holder: IAcpResidentBudgetHolder): IDisposable {
    this._holders.add(holder)
    return toDisposable(() => {
      this._holders.delete(holder)
    })
  }

  totalBytes(): number {
    let total = 0
    for (const h of this._holders) total += h.residentBytes()
    return total
  }

  reconcile(origin: string): void {
    if (this._reconciling) return
    let total = this.totalBytes()
    if (total <= this._budget) return
    this._reconciling = true
    let released = 0
    let trimmed = 0
    try {
      // Oldest ingestion first. The session that just ingested sorts last, so
      // the foreground conversation is the last to lose content.
      const ordered = [...this._holders].sort((a, b) => a.lastIngestAt() - b.lastIngestAt())
      for (const holder of ordered) {
        if (total <= this._budget) break
        const excess = total - this._budget
        const target = Math.max(0, holder.residentBytes() - excess)
        const freed = holder.trimToward(target)
        if (freed <= 0) continue
        released += freed
        trimmed++
        total -= freed
      }
    } finally {
      this._reconciling = false
    }
    if (released > 0) {
      console.warn(
        `[acp] shared resident budget exceeded (${origin}): released ${released} bytes ` +
          `from ${trimmed} of ${this._holders.size} sessions, now ${total}/${this._budget}`,
      )
    }
  }

  releaseFraction(fraction: number): number {
    if (this._reconciling) return 0
    this._reconciling = true
    let released = 0
    // Counts the sessions that actually gave something back — the registered total is a
    // different number, and "who released" is the only thing this line is read for.
    let trimmed = 0
    try {
      const ordered = [...this._holders].sort((a, b) => a.lastIngestAt() - b.lastIngestAt())
      for (const holder of ordered) {
        const current = holder.residentBytes()
        const target = Math.max(0, Math.floor(current * fraction))
        if (target >= current) continue
        const freed = holder.trimToward(target)
        if (freed <= 0) continue
        released += freed
        trimmed++
      }
    } finally {
      this._reconciling = false
    }
    if (released > 0) {
      console.warn(
        `[acp] memory pressure: released ${released} bytes from ${trimmed} of ` +
          `${this._holders.size} sessions (trimmed to ${Math.round(fraction * 100)}%)`,
      )
    }
    return released
  }
}

/**
 * Process-wide budget shared by every `AcpSession` in this renderer. A module
 * singleton rather than a DI service so `AcpSession`'s constructor can default
 * to it — the session factory then needs no new wiring, and tests can pass a
 * small private budget instead.
 */
export const sharedResidentBudget: IAcpResidentBudget = new AcpResidentBudget()
