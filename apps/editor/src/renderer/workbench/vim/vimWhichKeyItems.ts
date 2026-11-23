/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Which-key candidates: given the effective keymap and the sequence typed so far,
 *  list what each possible next key does. Pure — the dispatcher supplies the
 *  `when` evaluation and the command-title lookup.
 *--------------------------------------------------------------------------------------------*/

import type { IVimKeymapEntry } from '@universe-editor/workbench-ui'
import { localize } from '@universe-editor/platform'
import type { IVimWhichKeyItem } from '../../services/vim/vimModeService.js'
import { formatVimToken } from '../../services/vim/vimKeyFormat.js'

function startsWith(keys: readonly string[], prefix: readonly string[]): boolean {
  if (keys.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (keys[i] !== prefix[i]) return false
  return true
}

/** Same precedence as the dispatcher's `runMatches`: surface-declared, `when`-gated, default. */
function rank(entry: IVimKeymapEntry): number {
  if (entry.scope === 'surface') return 0
  return entry.when === undefined ? 2 : 1
}

interface Candidate {
  leaf: IVimKeymapEntry | undefined
  deeper: number
}

export function computeWhichKeyItems(
  entries: readonly IVimKeymapEntry[],
  prefix: readonly string[],
  isActive: (entry: IVimKeymapEntry) => boolean,
  resolveTitle: (command: string) => string,
): readonly IVimWhichKeyItem[] {
  const candidates = new Map<string, Candidate>()
  for (const entry of entries) {
    if (entry.keys.length <= prefix.length || !startsWith(entry.keys, prefix)) continue
    if (!isActive(entry)) continue
    const next = entry.keys[prefix.length]!
    const candidate = candidates.get(next) ?? { leaf: undefined, deeper: 0 }
    if (entry.keys.length === prefix.length + 1) {
      if (candidate.leaf === undefined || rank(entry) < rank(candidate.leaf)) {
        candidate.leaf = entry
      }
    } else {
      candidate.deeper++
    }
    candidates.set(next, candidate)
  }

  const items: IVimWhichKeyItem[] = []
  for (const [token, { leaf, deeper }] of candidates) {
    const key = formatVimToken(token)
    if (deeper === 0 && leaf !== undefined) {
      items.push({ key, title: resolveTitle(leaf.command), isGroup: false })
      continue
    }
    const more = localize('vim.whichKey.more', '+{count}', { count: deeper })
    items.push({
      key,
      title: leaf === undefined ? more : `${resolveTitle(leaf.command)} (${more})`,
      isGroup: true,
    })
  }
  return items
}
