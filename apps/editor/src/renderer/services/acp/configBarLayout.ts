/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for the config bar inside PromptInput's action row: the
 *  single source of truth for its entry order (earlier entries keep their
 *  slots first when the bar overflows). The sub-agent picker is deliberately
 *  glued right after the last model option — both pick a model, one semantic
 *  family — and the MCP picker is always last. Kept out of the UI layer so
 *  the order is unit-testable.
 *--------------------------------------------------------------------------------------------*/

import type { SessionConfigOption, SessionConfigOptionCategory } from '@agentclientprotocol/sdk'

/** Reserved entry key for the MCP picker. */
export const MCP_ENTRY_KEY = '__mcp__'
/** Reserved entry key for the sub-agent picker (claude-code only). */
export const SUBAGENT_ENTRY_KEY = '__subagent__'

export type ConfigBarEntry =
  | {
      readonly kind: 'option'
      readonly key: string
      readonly option: SessionConfigOption & { type: 'select' }
    }
  | { readonly kind: 'subagent'; readonly key: typeof SUBAGENT_ENTRY_KEY }
  | { readonly kind: 'mcp'; readonly key: typeof MCP_ENTRY_KEY }

const CATEGORY_ORDER: SessionConfigOptionCategory[] = ['model', 'mode', 'thought_level']

export function compareByCategory(a: SessionConfigOption, b: SessionConfigOption): number {
  const ai = a.category ? CATEGORY_ORDER.indexOf(a.category as SessionConfigOptionCategory) : -1
  const bi = b.category ? CATEGORY_ORDER.indexOf(b.category as SessionConfigOptionCategory) : -1
  const aw = ai === -1 ? CATEGORY_ORDER.length + 1 : ai
  const bw = bi === -1 ? CATEGORY_ORDER.length + 1 : bi
  return aw - bw
}

/**
 * Build the ordered entry list for the config bar. Non-select options (e.g.
 * `type: 'boolean'`) render no trigger at all, so they are dropped here — an
 * entry for them would be a zero-width slot that still eats a flex gap and can
 * light the overflow button with nothing to show.
 * `includeSubagent` = the claude-code sub-agent picker is rendered;
 * `includeMcp` = this session actually renders the MCP picker (writable
 * session + non-empty server pool — see `isMcpPickerHidden`).
 */
export function buildConfigBarEntries(
  options: readonly SessionConfigOption[],
  opts: { readonly includeSubagent: boolean; readonly includeMcp: boolean },
): ConfigBarEntry[] {
  const ordered = [...options].sort(compareByCategory)
  const selectOptions = ordered.filter(
    (option): option is SessionConfigOption & { type: 'select' } => option.type === 'select',
  )
  const entries: ConfigBarEntry[] = selectOptions.map((option) => ({
    kind: 'option',
    key: option.id,
    option,
  }))
  if (opts.includeSubagent) {
    // Glue the sub-agent picker right after the last model option (both pick a model).
    let lastModel = -1
    for (const [i, option] of selectOptions.entries()) {
      if (option.category === 'model') lastModel = i
    }
    entries.splice(lastModel + 1, 0, { kind: 'subagent', key: SUBAGENT_ENTRY_KEY })
  }
  if (opts.includeMcp) {
    entries.push({ kind: 'mcp', key: MCP_ENTRY_KEY })
  }
  return entries
}

/**
 * Greedy bin-packing for the single-line config bar in two passes. Walk
 * `keys` in priority order (array index = priority): no entry is skipped in
 * favour of a later one, and the first entry that no longer fits — with every
 * entry after it — lands in the overflow set.
 *
 * Pass 1 — nothing overflows: all entries stay in the flex line and the ⋯
 * button is `data-empty` → `position: absolute`, costing no width and no gap.
 * `sum(widthOf(k)) + (n-1)*gap <= clientWidth` returns the empty set.
 *
 * Pass 2 — at least one entry overflows, so the button stays in the flow:
 * accept entry i iff
 * `used + (i === 0 ? 0 : gap) + widthOf(key) + gap + buttonWidth <= clientWidth`
 * — the trailing `gap` is the one between the last visible entry and the
 * button, which exists exactly when an entry is accepted. This bound is
 * strictly stricter than pass 1's (it adds `gap + buttonWidth`), so a failed
 * pass 1 guarantees a non-empty overflow set and therefore the button's
 * presence in the flow: pass 2's reservations are self-consistent, and a
 * successful pass 1 likewise makes its own no-button assumption true. Each
 * branch's assumption matches its output, so there is no positive feedback
 * loop (an overflow materializes the button, whose width pushes the same
 * entry back inline, and so on); the inputs (each entry's natural
 * `offsetWidth`, the flex-driven `clientWidth`) do not depend on the output,
 * which is the premise for that.
 *
 * k=0 needs no special case: the button's leading gap is only reserved when
 * an entry is accepted, so a fully overflowed bar is just the button alone.
 */
export function splitConfigBarOverflow(
  keys: readonly string[],
  widthOf: (key: string) => number,
  clientWidth: number,
  buttonWidth: number,
  gap: number,
): ReadonlySet<string> {
  // Pass 1: everything inline, the button out of the flow.
  let inlineTotal = 0
  for (let i = 0; i < keys.length; i++) {
    inlineTotal += (i === 0 ? 0 : gap) + widthOf(keys[i]!)
  }
  if (inlineTotal <= clientWidth) return new Set()

  // Pass 2: an overflow is certain, so the button is in the flow; reserve its
  // width plus the gap between it and the last visible entry.
  const overflowed = new Set<string>()
  let used = 0
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!
    const slot = used + (i === 0 ? 0 : gap) + widthOf(key) + gap + buttonWidth
    if (slot > clientWidth) {
      for (let j = i; j < keys.length; j++) overflowed.add(keys[j]!)
      break
    }
    used += (i === 0 ? 0 : gap) + widthOf(key)
  }
  return overflowed
}
