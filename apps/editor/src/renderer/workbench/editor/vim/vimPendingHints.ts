/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Which-key candidates for the editor's Vim core (`g` / `z` / `[` / `]` tables,
 *  operator-pending, `i` / `a` text objects, Visual `g`). Derived from the same
 *  registries the reducer reads, so a new binding shows up without a second edit.
 *  Titles reuse `vimKeyHelp`'s localization to stay identical to the cheat sheet.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { IVimPendingHint, IVimPendingHintItem } from '@universe-editor/workbench-ui'
import { formatVimToken } from '../../../services/vim/vimKeyFormat.js'
import { describeVimKeyHelp } from './vimKeyHelp.js'
import { PREFIX_TABLES, formatPendingKeys, type VimPrefixEntry } from './vimKeymap.js'
import { VIM_MOTIONS, getVimMotion } from './vimMotions.js'
import { getVimOperator } from './vimOperators.js'
import { VIM_TEXT_OBJECTS } from './vimTextObjects.js'
import { isVisualMode, type VimOperator, type VimState } from './vimTypes.js'
import { VISUAL_G_ACTION_KEYS } from './vimVisual.js'

function item(key: string, title: string, isGroup = false): IVimPendingHintItem {
  return { key: formatVimToken(key), title, isGroup }
}

function linewiseTitle(action: string): string {
  return localize('vim.whichKey.linewise', '{action} (whole line)', { action })
}

function prefixEntryItem(key: string, entry: VimPrefixEntry): IVimPendingHintItem {
  if ('motion' in entry)
    return item(key, describeVimKeyHelp(getVimMotion(entry.motion).description))
  if ('operator' in entry) {
    return item(key, describeVimKeyHelp(getVimOperator(entry.operator).description))
  }
  return item(key, describeVimKeyHelp(entry.description))
}

let normalG: readonly IVimPendingHintItem[] | undefined

function normalGItems(): readonly IVimPendingHintItem[] {
  normalG ??= [...PREFIX_TABLES.g.entries].map(([key, entry]) => prefixEntryItem(key, entry))
  return normalG
}

let visualG: readonly IVimPendingHintItem[] | undefined

function visualGItems(): readonly IVimPendingHintItem[] {
  if (visualG !== undefined) return visualG
  const items = [...VISUAL_G_ACTION_KEYS].map(([key, def]) =>
    item(key, describeVimKeyHelp(def.description)),
  )
  const seen = new Set(VISUAL_G_ACTION_KEYS.keys())
  for (const [key, entry] of PREFIX_TABLES.g.entries) {
    // The Visual actions above override `J` / `u` / `U` / `~`; the remaining
    // operators are rejected by the reducer in Visual mode.
    if (seen.has(key) || 'operator' in entry) continue
    items.push(prefixEntryItem(key, entry))
  }
  visualG = items
  return items
}

const operatorG = new Map<VimOperator, readonly IVimPendingHintItem[]>()

/**
 * `g` after an operator only keeps motions: the table's commands would run and
 * silently drop the pending operator, so listing them would be a lie.
 */
function operatorGItems(operator: VimOperator): readonly IVimPendingHintItem[] {
  const cached = operatorG.get(operator)
  if (cached !== undefined) return cached
  const items: IVimPendingHintItem[] = []
  for (const [key, entry] of PREFIX_TABLES.g.entries) {
    if ('motion' in entry) items.push(prefixEntryItem(key, entry))
    else if ('operator' in entry && entry.operator === operator) {
      const def = getVimOperator(entry.operator)
      items.push(item(key, linewiseTitle(describeVimKeyHelp(def.description))))
    }
  }
  operatorG.set(operator, items)
  return items
}

const staticPrefixes = new Map<'z' | '[' | ']', readonly IVimPendingHintItem[]>()

function staticPrefixItems(kind: 'z' | '[' | ']'): readonly IVimPendingHintItem[] {
  const cached = staticPrefixes.get(kind)
  if (cached !== undefined) return cached
  const items = [...PREFIX_TABLES[kind].entries].map(([key, entry]) => prefixEntryItem(key, entry))
  staticPrefixes.set(kind, items)
  return items
}

const textObjects: {
  inner?: readonly IVimPendingHintItem[]
  around?: readonly IVimPendingHintItem[]
} = {}

function textObjectItems(around: boolean): readonly IVimPendingHintItem[] {
  const cached = around ? textObjects.around : textObjects.inner
  if (cached !== undefined) return cached
  const label = around ? 'Around' : 'Inner'
  const items: IVimPendingHintItem[] = []
  const seen = new Set<string>()
  for (const object of VIM_TEXT_OBJECTS) {
    for (const key of object.keys) {
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item(key, describeVimKeyHelp(`${label} ${object.description}`)))
    }
  }
  if (around) textObjects.around = items
  else textObjects.inner = items
  return items
}

const operatorPending = new Map<VimOperator, readonly IVimPendingHintItem[]>()

function operatorPendingItems(operator: VimOperator): readonly IVimPendingHintItem[] {
  const cached = operatorPending.get(operator)
  if (cached !== undefined) return cached
  const def = getVimOperator(operator)
  const items: IVimPendingHintItem[] = [
    item(def.key, linewiseTitle(describeVimKeyHelp(def.description))),
    item('i', localize('vim.whichKey.innerTextObject', 'Inner text object'), true),
    item('a', localize('vim.whichKey.aroundTextObject', 'Around text object'), true),
  ]
  const seen = new Set(items.map((entry) => entry.key))
  for (const motion of VIM_MOTIONS) {
    for (const key of motion.keys) {
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item(key, describeVimKeyHelp(motion.description)))
    }
  }
  const g = operatorGItems(operator)
  if (g.length > 0) {
    items.push({
      key: 'g',
      title: localize('vim.whichKey.more', '+{count}', { count: g.length }),
      isGroup: true,
    })
  }
  operatorPending.set(operator, items)
  return items
}

/** The keys that can follow the core's pending prefix, or undefined when there is no list. */
export function computeVimPendingHint(state: VimState): IVimPendingHint | undefined {
  if (state.mode === 'insert') return undefined
  const pending = state.pending
  let items: readonly IVimPendingHintItem[]
  if (pending !== null) {
    switch (pending.kind) {
      case 'find':
      case 'replace':
      case 'register':
        // A char argument, not a choice of commands.
        return undefined
      case 'textobject':
        items = textObjectItems(pending.around)
        break
      case 'g':
        if (state.pendingOperator !== null) items = operatorGItems(state.pendingOperator)
        else if (isVisualMode(state.mode)) items = visualGItems()
        else items = normalGItems()
        break
      case 'z':
      case '[':
      case ']':
        items = staticPrefixItems(pending.kind)
        break
    }
  } else if (state.pendingOperator !== null) {
    items = operatorPendingItems(state.pendingOperator)
  } else {
    return undefined
  }
  if (items.length === 0) return undefined
  return { prefix: formatPendingKeys(state), items }
}
