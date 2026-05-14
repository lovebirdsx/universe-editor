/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Simplified keybinding registry for M1. Only supports single-combo bindings
 *  (Ctrl/Cmd+Key). Chord bindings and full resolver are deferred to M2.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, toDisposable } from '../base/lifecycle.js'

/**
 * Simplified keybinding descriptor. Uses a platform-neutral string format:
 * e.g. "ctrl+k", "meta+shift+p", "f1"
 */
export interface IKeybindingItem {
  /** Platform-neutral key combination string. */
  key: string
  /** The command to execute. */
  command: string
  /** Optional context-key expression for when this binding is active. */
  when?: string
  /** When set, pressing the key removes the binding rather than invoking the command. */
  isNegated?: boolean
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

class KeybindingsRegistryImpl {
  private readonly _items: IKeybindingItem[] = []

  registerKeybinding(item: IKeybindingItem): IDisposable {
    const normalized = { ...item, key: normalizeKey(item.key) }
    this._items.push(normalized)

    return toDisposable(() => {
      const idx = this._items.indexOf(normalized)
      if (idx !== -1) {
        this._items.splice(idx, 1)
      }
    })
  }

  /**
   * Returns all bindings whose key matches, sorted newest-first.
   */
  getBindingsForKey(key: string): IKeybindingItem[] {
    const normalized = normalizeKey(key)
    return [...this._items].reverse().filter((item) => item.key === normalized)
  }

  /**
   * Returns the command bound to the given key, or undefined if none.
   * Honors when-clause by checking context keys (simplified: truthy check on provided context).
   */
  resolveKeybinding(key: string, contextKeys?: Record<string, unknown>): string | undefined {
    const bindings = this.getBindingsForKey(key)
    for (const binding of bindings) {
      if (binding.isNegated) {
        continue
      }
      if (binding.when && contextKeys) {
        const val = contextKeys[binding.when]
        if (!val) {
          continue
        }
      }
      return binding.command
    }
    return undefined
  }

  getAllKeybindings(): readonly IKeybindingItem[] {
    return this._items
  }
}

export const KeybindingsRegistry: KeybindingsRegistryImpl = new KeybindingsRegistryImpl()
