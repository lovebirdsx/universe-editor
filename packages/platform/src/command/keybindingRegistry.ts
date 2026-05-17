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
      if (binding.chords.length !== 1) continue
      if (binding.chords[0] !== normalized) continue
      if (binding.isNegated) continue
      if (binding.when !== undefined && contextKeyService) {
        if (!contextKeyService.contextMatchesRules(binding.when)) continue
      }
      return binding.command
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
        if (binding.chords.length !== 2) continue
        if (binding.chords[0] !== first || binding.chords[1] !== normalized) continue
        if (binding.isNegated) continue
        if (binding.when !== undefined && contextKeyService) {
          if (!contextKeyService.contextMatchesRules(binding.when)) continue
        }
        return { kind: 'execute', command: binding.command }
      }
      return { kind: 'no-match' }
    }

    // Chord-first: if any 2-stroke chord starts with this key and its
    // when-clause is satisfied, enter chord mode. This prevents a competing
    // single-stroke binding on the same key from swallowing the chord's
    // first stroke.
    for (let i = this._items.length - 1; i >= 0; i--) {
      const binding = this._items[i]!
      if (binding.chords.length !== 2) continue
      if (binding.chords[0] !== normalized) continue
      if (binding.isNegated) continue
      if (binding.when !== undefined && contextKeyService) {
        if (!contextKeyService.contextMatchesRules(binding.when)) continue
      }
      return { kind: 'enter-chord', pending: [normalized] }
    }

    // No active chord prefix — fall through to single-stroke.
    const singleHit = this.resolveKeybinding(normalized, contextKeyService)
    if (singleHit !== undefined) return { kind: 'execute', command: singleHit }

    return { kind: 'no-match' }
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
