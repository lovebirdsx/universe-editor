/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The editor Vim core's bracket-table commands (`]d` / `[d` / `]c` / `[c`).
 *  They live here rather than in `workbench/editor/vim/vimKeymap.ts` so the
 *  services layer can register their ids for `vim.keymap` overrides without
 *  importing from the workbench. `vimKeymap.ts` builds the actual prefix
 *  entries from this catalog; keeping the keys in one place stops the two
 *  halves from drifting.
 *--------------------------------------------------------------------------------------------*/

import type { IVimKeymapEntry } from '@universe-editor/workbench-ui'

export type VimCorePrefix = '[' | ']'

export interface VimCoreKeymapEntry {
  readonly id: string
  readonly prefix: VimCorePrefix
  readonly key: string
  /** The command the key runs; a `vim.keymap` alias of this id inherits it. */
  readonly command: string
  /** `platform` commands take the Vim count; `editor` commands are Monaco actions. */
  readonly target: 'platform' | 'editor'
  readonly description: string
}

export const VIM_CORE_KEYMAP: readonly VimCoreKeymapEntry[] = [
  {
    id: 'editor.nextDiagnostic',
    prefix: ']',
    key: 'd',
    command: 'editor.action.marker.nextInFiles',
    target: 'editor',
    description: 'Next diagnostic',
  },
  {
    id: 'editor.previousDiagnostic',
    prefix: '[',
    key: 'd',
    command: 'editor.action.marker.prevInFiles',
    target: 'editor',
    description: 'Previous diagnostic',
  },
  {
    id: 'editor.nextChange',
    prefix: ']',
    key: 'c',
    command: 'workbench.action.editor.nextChange',
    target: 'platform',
    description: 'Next change (diff)',
  },
  {
    id: 'editor.previousChange',
    prefix: '[',
    key: 'c',
    command: 'workbench.action.editor.previousChange',
    target: 'platform',
    description: 'Previous change (diff)',
  },
]

/** The same entries as `vim.keymap` sees them, for id registration and command inheritance. */
export const VIM_CORE_KEYMAP_ENTRIES: readonly IVimKeymapEntry[] = VIM_CORE_KEYMAP.map(
  ({ id, prefix, key, command }) => ({
    id,
    keys: [prefix, key],
    command,
    surfaces: ['editor'],
  }),
)

export const VIM_CORE_IDS: ReadonlySet<string> = new Set(VIM_CORE_KEYMAP.map((entry) => entry.id))
