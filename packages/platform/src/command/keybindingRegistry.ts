/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Simplified keybinding registry. Supports single-combo bindings with
 *  context-key when-clauses. Chord bindings deferred to a later milestone.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../base/lifecycle.js'
import { IContextKeyService } from './contextKey.js'
import { ContextKeyExpr, ContextKeyExpression } from './contextKeyExpr.js'

/**
 * Simplified keybinding descriptor. Uses a platform-neutral string format:
 * e.g. "ctrl+k", "meta+shift+p", "f1"
 */
export interface IKeybindingItem {
  /** Platform-neutral key combination string. */
  key: string
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
  key: string
  command: string
  when: ContextKeyExpression | undefined
  isNegated: boolean
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

class KeybindingsRegistryImpl {
  private readonly _items: IResolvedKeybindingItem[] = []

  registerKeybinding(item: IKeybindingItem): IDisposable {
    const resolved: IResolvedKeybindingItem = {
      key: normalizeKey(item.key),
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
   * Returns all bindings whose key matches, sorted newest-first.
   * For backward compatibility with tests that introspected the items.
   */
  getBindingsForKey(key: string): IKeybindingItem[] {
    const normalized = normalizeKey(key)
    return [...this._items]
      .reverse()
      .filter((item) => item.key === normalized)
      .map((it) => ({
        key: it.key,
        command: it.command,
        ...(it.when !== undefined ? { when: it.when } : {}),
        ...(it.isNegated ? { isNegated: it.isNegated } : {}),
      }))
  }

  /**
   * Returns the command bound to the given key, or undefined if none.
   * If a context-key service is provided, when-clauses are evaluated against it
   * and bindings whose when-clause is false are skipped.
   */
  resolveKeybinding(key: string, contextKeyService?: IContextKeyService): string | undefined {
    const normalized = normalizeKey(key)
    // Iterate in reverse (newest first) so later registrations win.
    for (let i = this._items.length - 1; i >= 0; i--) {
      const binding = this._items[i]!
      if (binding.key !== normalized) continue
      if (binding.isNegated) continue
      if (binding.when !== undefined && contextKeyService) {
        if (!contextKeyService.contextMatchesRules(binding.when)) continue
      }
      return binding.command
    }
    return undefined
  }

  getAllKeybindings(): readonly IKeybindingItem[] {
    return this._items.map((it) => ({
      key: it.key,
      command: it.command,
      ...(it.when !== undefined ? { when: it.when } : {}),
      ...(it.isNegated ? { isNegated: it.isNegated } : {}),
    }))
  }
}

export const KeybindingsRegistry: KeybindingsRegistryImpl = new KeybindingsRegistryImpl()
