/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim sequence state machine — counts, multi-token prefixes, Esc cancellation
 *  and the "complete entry that is also a longer prefix" wait. One instance per
 *  surface; the caller owns the timeout timer and calls `flush()` when it fires.
 *
 *  Pure and timer-free so it can be exhaustively unit-tested under node.
 *--------------------------------------------------------------------------------------------*/

import type { IVimKeymapEntry } from './vimTypes.js'

export type VimSequenceStep =
  /** The stroke belongs to nobody; the caller decides whether to pass it on. */
  | { readonly kind: 'none' }
  /** The stroke was consumed; wait for more tokens or the timeout. */
  | { readonly kind: 'pending'; readonly count: number; readonly prefix: readonly string[] }
  /** A full sequence matched. */
  | {
      readonly kind: 'execute'
      readonly matches: readonly IVimKeymapEntry[]
      readonly count: number
    }
  /** Esc cancelled a pending count/prefix. */
  | { readonly kind: 'cancel' }

interface DeferredMatch {
  readonly matches: readonly IVimKeymapEntry[]
  readonly count: number
}

function startsWith(candidate: readonly string[], keys: readonly string[]): boolean {
  if (candidate.length > keys.length) return false
  for (let i = 0; i < candidate.length; i++) if (candidate[i] !== keys[i]) return false
  return true
}

function equalKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export class VimSequenceEngine {
  private _entries: readonly IVimKeymapEntry[]
  private _count = 0
  private _prefix: readonly string[] = []
  private _deferred: DeferredMatch | undefined

  constructor(entries: readonly IVimKeymapEntry[] = []) {
    this._entries = entries
  }

  /** Keymaps change with configuration; pending state is intentionally kept. */
  setEntries(entries: readonly IVimKeymapEntry[]): void {
    // The service caches the effective keymap per (kind, leader, config
    // version), so an unchanged reference means no configuration change.
    if (this._entries === entries) return
    this._entries = entries
  }

  get isPending(): boolean {
    return this._count > 0 || this._prefix.length > 0
  }

  get count(): number {
    return this._count
  }

  reset(): void {
    this._count = 0
    this._prefix = []
    this._deferred = undefined
  }

  feed(token: string): VimSequenceStep {
    if (token === 'escape' && this.isPending) {
      this.reset()
      return { kind: 'cancel' }
    }

    // Counts only start a command and only continue one; a bare `0` is the
    // line-start motion and must stay available to the keymap.
    if (this._prefix.length === 0) {
      if (token.length === 1 && token >= '1' && token <= '9') {
        this._count = this._count * 10 + Number(token)
        return { kind: 'pending', count: this._count, prefix: this._prefix }
      }
      if (token === '0' && this._count > 0) {
        this._count *= 10
        return { kind: 'pending', count: this._count, prefix: this._prefix }
      }
    }

    const candidate = [...this._prefix, token]
    const exact = this._entries.filter((entry) => equalKeys(entry.keys, candidate))
    const longer = this._entries.filter(
      (entry) => entry.keys.length > candidate.length && startsWith(candidate, entry.keys),
    )

    if (longer.length > 0) {
      this._prefix = candidate
      // `z` may be both a command and the head of `za`; wait for the timeout or
      // the next token before deciding.
      this._deferred = exact.length > 0 ? { matches: exact, count: this._count } : undefined
      return { kind: 'pending', count: this._count, prefix: candidate }
    }

    if (exact.length > 0) {
      const count = this._count
      this.reset()
      return { kind: 'execute', matches: exact, count }
    }

    // The next token broke an ambiguous prefix: fire what was already complete.
    if (this._deferred !== undefined) {
      const deferred = this._deferred
      this.reset()
      return { kind: 'execute', matches: deferred.matches, count: deferred.count }
    }

    // Incomplete prefix matched nothing: cancel and let the caller route it.
    this.reset()
    return { kind: 'none' }
  }

  /** Called when the caller's sequence timeout fires. */
  flush(): VimSequenceStep {
    if (this._deferred !== undefined) {
      const deferred = this._deferred
      this.reset()
      return { kind: 'execute', matches: deferred.matches, count: deferred.count }
    }
    if (this.isPending) {
      this.reset()
      return { kind: 'cancel' }
    }
    return { kind: 'none' }
  }
}
