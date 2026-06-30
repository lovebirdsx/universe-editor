/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers over a `SessionConfigOption` bag: resolve a value's friendly
 *  display name, and snapshot the current select selections (value + label) so
 *  the durable history can show model / effort on rows that are no longer live.
 *  Kept out of the UI layer so both services and components can reuse it.
 *--------------------------------------------------------------------------------------------*/

import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'

/** Resolve the friendly name for `value` within an option's (possibly grouped) list, falling back to the raw value. */
export function findConfigOptionLabel(
  options: readonly SessionConfigSelectOption[] | readonly SessionConfigSelectGroup[],
  value: string,
): string {
  if (options.length === 0) return value
  const first = options[0]!
  if ('group' in first) {
    for (const g of options as readonly SessionConfigSelectGroup[]) {
      for (const v of g.options) if (v.value === value) return v.name
    }
    return value
  }
  for (const v of options as readonly SessionConfigSelectOption[]) {
    if (v.value === value) return v.name
  }
  return value
}

export interface ConfigSelectionSnapshot {
  /** configId → currentValue, for every `select` option in the bag. */
  readonly values: Readonly<Record<string, string>>
  /** configId → friendly display name of the current value. */
  readonly labels: Readonly<Record<string, string>>
}

/**
 * Snapshot the current selection of every `select` option in a bag. Used when a
 * session is created / resumed so the durable history carries the model / effort
 * (value AND friendly label) even for the default selection the user never
 * touched — otherwise the sidebar row can only show them while the session is live.
 */
export function snapshotConfigSelections(
  options: readonly SessionConfigOption[],
): ConfigSelectionSnapshot {
  const values: Record<string, string> = {}
  const labels: Record<string, string> = {}
  for (const opt of options) {
    if (opt.type !== 'select') continue
    values[opt.id] = opt.currentValue
    labels[opt.id] = findConfigOptionLabel(opt.options, opt.currentValue)
  }
  return { values, labels }
}
