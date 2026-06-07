/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keybinding registry. Supports single-stroke and 2-stroke "chord" bindings
 *  (e.g. `Ctrl+K Ctrl+S`), with context-key when-clauses.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../base/lifecycle.js'
import { IContextKeyService } from './contextKey.js'
import { ContextKeyExpr, ContextKeyExpression } from './contextKeyExpr.js'

/**
 * Simplified keybinding descriptor. Uses a platform-neutral string format:
 * e.g. "ctrl+k", "meta+shift+p", "f1". A `chords` tuple expresses a 2-stroke
 * chord; `key` (legacy single-stroke) is still accepted and stored as a
 * 1-element chord internally.
 */
export interface IKeybindingItem {
  /**
   * Platform-neutral key combination string for a single-stroke binding.
   * Mutually exclusive with `chords`.
   */
  key?: string
  /**
   * 2-stroke chord, e.g. ['ctrl+k', 'ctrl+s']. Mutually exclusive with `key`.
   */
  chords?: readonly [string, string]
  /** The command to execute. */
  command: string
  /**
   * Optional context-key expression for when this binding is active.
   * Accepts either a serialized when-clause string or a pre-built AST node.
   */
  when?: ContextKeyExpression | string
  /** When set, pressing the key removes the binding rather than invoking the command. */
  isNegated?: boolean
}

interface IResolvedKeybindingItem {
  chords: readonly string[]
  command: string
  when: ContextKeyExpression | undefined
  isNegated: boolean
}

/**
 * Result of feeding one keystroke to {@link KeybindingsRegistryImpl.resolveKeystroke}.
 * - `execute`  → command fully resolved, fire it.
 * - `enter-chord` → first half of a 2-stroke chord matched, caller should hold
 *   `pending` and feed the next keystroke alongside it.
 * - `no-match` → nothing matched.
 */
export type KeystrokeResolution =
  | { kind: 'execute'; command: string }
  | { kind: 'enter-chord'; pending: readonly string[] }
  | { kind: 'no-match' }

/** Why a candidate binding did or did not match a keystroke. */
export type BindingSkipReason =
  | 'matched'
  | 'wrong-chord-length'
  | 'key-mismatch'
  | 'is-negated'
  | 'when-failed'

/** Snapshot of a single context key referenced by a binding's when-clause. */
export interface IKeybindingWhenKeyState {
  readonly key: string
  readonly value: unknown
}

/**
 * One candidate binding examined while resolving a keystroke, with the reason
 * it matched or was skipped — the core data for "why did my key do nothing".
 */
export interface IKeybindingTraceCandidate {
  readonly chords: readonly string[]
  readonly command: string
  readonly isNegated: boolean
  /** Serialized when-clause, or undefined when the binding has none. */
  readonly when: string | undefined
  /** Current value of every context key the when-clause references. */
  readonly whenKeys: readonly IKeybindingWhenKeyState[]
  readonly whenMatched: boolean
  readonly outcomeReason: BindingSkipReason
  /** True for the single candidate that won (at most one per trace). */
  readonly selected: boolean
}

/**
 * Structured diagnostics mirroring {@link KeybindingsRegistryImpl.resolveKeystroke},
 * but recording every key-matching candidate and why it was kept or skipped.
 */
export type KeystrokeTrace =
  | {
      readonly kind: 'execute'
      readonly normalizedKey: string
      readonly pending: readonly string[] | undefined
      readonly command: string
      readonly candidates: readonly IKeybindingTraceCandidate[]
    }
  | {
      readonly kind: 'enter-chord'
      readonly normalizedKey: string
      readonly pending: readonly string[] | undefined
      readonly chordPending: readonly string[]
      readonly candidates: readonly IKeybindingTraceCandidate[]
    }
  | {
      readonly kind: 'no-match'
      readonly normalizedKey: string
      readonly pending: readonly string[] | undefined
      readonly candidates: readonly IKeybindingTraceCandidate[]
    }

/**
 * Normalizes a key string to lowercase with sorted modifier order.
 * Canonical form: ctrl+alt+shift+meta+<key>
 */
function normalizeKey(key: string): string {
  const parts = key
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
  const modifiers = new Set(['ctrl', 'alt', 'shift', 'meta'])
  const mods = parts.filter((p) => modifiers.has(p)).sort()
  const rest = parts.filter((p) => !modifiers.has(p))
  return [...mods, ...rest].join('+')
}

function resolveWhen(when: IKeybindingItem['when']): ContextKeyExpression | undefined {
  if (when === undefined) return undefined
  if (typeof when === 'string') return ContextKeyExpr.deserialize(when)
  return when
}

function itemChords(item: IKeybindingItem): readonly string[] {
  if (item.chords) return [normalizeKey(item.chords[0]), normalizeKey(item.chords[1])]
  if (item.key !== undefined) return [normalizeKey(item.key)]
  throw new Error('Keybinding item requires either `key` or `chords`.')
}

/** Matching mode for {@link evaluateBinding}. */
type BindingMatchMode = 'single' | 'chord-prefix' | 'chord-complete'

/**
 * Single source of truth for "does this binding match this stroke", shared by
 * the resolve and trace paths so the two can never disagree. Checks run in the
 * order: chord length → key → isNegated → when-clause.
 */
function evaluateBinding(
  binding: IResolvedKeybindingItem,
  mode: BindingMatchMode,
  strokeNormalized: string,
  pendingFirstNormalized: string | undefined,
  contextKeyService: IContextKeyService | undefined,
): { matched: boolean; reason: BindingSkipReason } {
  const expectedLength = mode === 'single' ? 1 : 2
  if (binding.chords.length !== expectedLength) {
    return { matched: false, reason: 'wrong-chord-length' }
  }
  if (mode === 'chord-complete') {
    if (binding.chords[0] !== pendingFirstNormalized || binding.chords[1] !== strokeNormalized) {
      return { matched: false, reason: 'key-mismatch' }
    }
  } else if (binding.chords[0] !== strokeNormalized) {
    return { matched: false, reason: 'key-mismatch' }
  }
  if (binding.isNegated) {
    return { matched: false, reason: 'is-negated' }
  }
  if (binding.when !== undefined && contextKeyService) {
    if (!contextKeyService.contextMatchesRules(binding.when)) {
      return { matched: false, reason: 'when-failed' }
    }
  }
  return { matched: true, reason: 'matched' }
}

class KeybindingsRegistryImpl {
  private readonly _items: IResolvedKeybindingItem[] = []

  registerKeybinding(item: IKeybindingItem): IDisposable {
    const resolved: IResolvedKeybindingItem = {
      chords: itemChords(item),
      command: item.command,
      when: resolveWhen(item.when),
      isNegated: item.isNegated ?? false,
    }
    this._items.push(resolved)

    return toDisposable(() => {
      const idx = this._items.indexOf(resolved)
      if (idx !== -1) {
        this._items.splice(idx, 1)
      }
    })
  }

  /**
   * Returns all bindings whose key matches, sorted newest-first. Single-stroke
   * bindings only — chord items are excluded for legacy callers.
   */
  getBindingsForKey(key: string): IKeybindingItem[] {
    const normalized = normalizeKey(key)
    return [...this._items]
      .reverse()
      .filter((item) => item.chords.length === 1 && item.chords[0] === normalized)
      .map((it) => ({
        key: it.chords[0]!,
        command: it.command,
        ...(it.when !== undefined ? { when: it.when } : {}),
        ...(it.isNegated ? { isNegated: it.isNegated } : {}),
      }))
  }

  /**
   * Returns the command bound to the given single key, or undefined if none.
   * Backward-compatible single-stroke lookup; chord items are not considered.
   * Use {@link resolveKeystroke} for chord-aware state-machine resolution.
   */
  resolveKeybinding(key: string, contextKeyService?: IContextKeyService): string | undefined {
    const normalized = normalizeKey(key)
    // Iterate in reverse (newest first) so later registrations win.
    for (let i = this._items.length - 1; i >= 0; i--) {
      const binding = this._items[i]!
      if (evaluateBinding(binding, 'single', normalized, undefined, contextKeyService).matched) {
        return binding.command
      }
    }
    return undefined
  }

  /**
   * Feed a keystroke through the chord state machine.
   * Caller passes `pending = [firstChord]` when continuing a chord, undefined
   * (or empty) for a fresh keystroke. Behaviour:
   * - **Chord-first**: if any 2-stroke chord starts with `key` and its
   *   when-clause passes, returns `enter-chord` — even when a single-stroke
   *   binding shares the same key. This matches VSCode's behaviour: a chord
   *   prefix shadows the single-stroke binding so the chord remains reachable.
   * - If no active chord prefix exists, a single-stroke binding is executed.
   * - When `pending` is supplied: matches against 2-stroke chords whose
   *   `chords[0] === pending[0] && chords[1] === key`.
   */
  resolveKeystroke(
    key: string,
    contextKeyService?: IContextKeyService,
    pending?: readonly string[],
  ): KeystrokeResolution {
    const normalized = normalizeKey(key)

    if (pending && pending.length > 0) {
      const first = normalizeKey(pending[0]!)
      for (let i = this._items.length - 1; i >= 0; i--) {
        const binding = this._items[i]!
        if (
          evaluateBinding(binding, 'chord-complete', normalized, first, contextKeyService).matched
        ) {
          return { kind: 'execute', command: binding.command }
        }
      }
      return { kind: 'no-match' }
    }

    // Chord-first: if any 2-stroke chord starts with this key and its
    // when-clause is satisfied, enter chord mode. This prevents a competing
    // single-stroke binding on the same key from swallowing the chord's
    // first stroke.
    for (let i = this._items.length - 1; i >= 0; i--) {
      const binding = this._items[i]!
      if (
        evaluateBinding(binding, 'chord-prefix', normalized, undefined, contextKeyService).matched
      ) {
        return { kind: 'enter-chord', pending: [normalized] }
      }
    }

    // No active chord prefix — fall through to single-stroke.
    const singleHit = this.resolveKeybinding(normalized, contextKeyService)
    if (singleHit !== undefined) return { kind: 'execute', command: singleHit }

    return { kind: 'no-match' }
  }

  /**
   * Diagnostic counterpart to {@link resolveKeystroke}: returns the same
   * decision plus every binding whose physical key matched the stroke and why
   * it was kept or skipped. Intended for keyboard-shortcut troubleshooting; not
   * on the hot dispatch path.
   */
  traceKeystroke(
    key: string,
    contextKeyService?: IContextKeyService,
    pending?: readonly string[],
  ): KeystrokeTrace {
    const normalized = normalizeKey(key)
    const pendingNormalized = pending && pending.length > 0 ? pending : undefined
    const candidates: IKeybindingTraceCandidate[] = []

    const describe = (
      binding: IResolvedKeybindingItem,
      reason: BindingSkipReason,
      selected: boolean,
    ): IKeybindingTraceCandidate => {
      const whenSerialized = binding.when?.serialize()
      const whenKeys: IKeybindingWhenKeyState[] =
        binding.when?.keys().map((k) => ({ key: k, value: contextKeyService?.get(k) })) ?? []
      return {
        chords: binding.chords,
        command: binding.command,
        isNegated: binding.isNegated,
        when: whenSerialized,
        whenKeys,
        whenMatched: reason !== 'when-failed',
        outcomeReason: reason,
        selected,
      }
    }

    // Mirror resolveKeystroke's branch selection and newest-first traversal.
    if (pendingNormalized) {
      const first = normalizeKey(pendingNormalized[0]!)
      let winner: IResolvedKeybindingItem | undefined
      for (let i = this._items.length - 1; i >= 0; i--) {
        const binding = this._items[i]!
        const { matched, reason } = evaluateBinding(
          binding,
          'chord-complete',
          normalized,
          first,
          contextKeyService,
        )
        // Only the second-stroke key matters here; skip unrelated bindings.
        if (reason === 'wrong-chord-length' || reason === 'key-mismatch') continue
        const selected = matched && winner === undefined
        if (selected) winner = binding
        candidates.push(describe(binding, reason, selected))
      }
      if (winner) {
        return {
          kind: 'execute',
          normalizedKey: normalized,
          pending: pendingNormalized,
          command: winner.command,
          candidates,
        }
      }
      return { kind: 'no-match', normalizedKey: normalized, pending: pendingNormalized, candidates }
    }

    // Chord-first prefix pass.
    let chordWinner: IResolvedKeybindingItem | undefined
    for (let i = this._items.length - 1; i >= 0; i--) {
      const binding = this._items[i]!
      const { matched, reason } = evaluateBinding(
        binding,
        'chord-prefix',
        normalized,
        undefined,
        contextKeyService,
      )
      if (reason === 'wrong-chord-length' || reason === 'key-mismatch') continue
      const selected = matched && chordWinner === undefined
      if (selected) chordWinner = binding
      candidates.push(describe(binding, reason, selected))
    }
    if (chordWinner) {
      return {
        kind: 'enter-chord',
        normalizedKey: normalized,
        pending: undefined,
        chordPending: [normalized],
        candidates,
      }
    }

    // Single-stroke pass.
    let singleWinner: IResolvedKeybindingItem | undefined
    for (let i = this._items.length - 1; i >= 0; i--) {
      const binding = this._items[i]!
      const { matched, reason } = evaluateBinding(
        binding,
        'single',
        normalized,
        undefined,
        contextKeyService,
      )
      if (reason === 'wrong-chord-length' || reason === 'key-mismatch') continue
      const selected = matched && singleWinner === undefined
      if (selected) singleWinner = binding
      candidates.push(describe(binding, reason, selected))
    }
    if (singleWinner) {
      return {
        kind: 'execute',
        normalizedKey: normalized,
        pending: undefined,
        command: singleWinner.command,
        candidates,
      }
    }

    return { kind: 'no-match', normalizedKey: normalized, pending: undefined, candidates }
  }

  getAllKeybindings(): readonly IKeybindingItem[] {
    return this._items.map((it) => {
      const base = {
        command: it.command,
        ...(it.when !== undefined ? { when: it.when } : {}),
        ...(it.isNegated ? { isNegated: it.isNegated } : {}),
      }
      if (it.chords.length === 2) {
        return { ...base, chords: [it.chords[0]!, it.chords[1]!] as [string, string] }
      }
      return { ...base, key: it.chords[0]! }
    })
  }
}

export const KeybindingsRegistry: KeybindingsRegistryImpl = new KeybindingsRegistryImpl()
