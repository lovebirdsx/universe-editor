/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The editor's Vim key reference, derived from the same registries the reducer reads
 *  (motions, operators, text objects, prefix tables, simple/ctrl commands, Visual
 *  actions) so a new binding shows up in the cheat sheet without a second edit. The
 *  few keys the reducer handles inline (`.`, `v`, `"x`…) are listed in `EXTRA_ROWS`.
 *
 *  Descriptions are English in the registries; here each is localized under
 *  `vim.keyHelp.<slug of the English text>` so equal texts share one translation.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { CTRL_COMMANDS, PREFIX_TABLES, SIMPLE_COMMANDS } from './vimKeymap.js'
import { VIM_MOTIONS } from './vimMotions.js'
import { VIM_OPERATORS } from './vimOperators.js'
import { VIM_TEXT_OBJECTS } from './vimTextObjects.js'
import { VISUAL_ACTION_KEYS, VISUAL_G_ACTION_KEYS } from './vimVisual.js'

export interface VimKeyHelpRow {
  readonly group: string
  readonly keys: string
  readonly description: string
}

/** Stable message-key suffix for an English description. */
export function keyHelpSlug(description: string): string {
  return description.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '')
}

/** Localized help text shared by the cheat sheet and which-key. */
export function describeVimKeyHelp(description: string): string {
  return localize(`vim.keyHelp.${keyHelpSlug(description)}`, description)
}

function groups() {
  return {
    motions: localize('vim.keyHelp.group.motions', 'Motions'),
    operators: localize('vim.keyHelp.group.operators', 'Operators'),
    textObjects: localize('vim.keyHelp.group.textObjects', 'Text objects'),
    editing: localize('vim.keyHelp.group.editing', 'Editing'),
    visual: localize('vim.keyHelp.group.visual', 'Visual mode'),
    registers: localize('vim.keyHelp.group.registers', 'Registers and repeat'),
    window: localize('vim.keyHelp.group.window', 'Window and folds'),
    search: localize('vim.keyHelp.group.search', 'Search'),
    goto: localize('vim.keyHelp.group.goto', 'Go to'),
  }
}

type Groups = ReturnType<typeof groups>

/** Keys the reducer handles inline rather than through a registry. */
const EXTRA_ROWS: readonly (readonly [keyof Groups, string, string])[] = [
  ['visual', 'v', 'Start Visual mode (characterwise)'],
  ['visual', 'V', 'Start Visual mode (linewise)'],
  ['visual', 'Ctrl+V', 'Start Visual mode (blockwise)'],
  ['visual', 'o / O', 'Go to the other end of the selection'],
  ['visual', 'I / A', 'Block mode: insert before / after the block on every row'],
  ['visual', 'i{object} / a{object}', 'Extend the selection by a text object'],
  ['visual', 'Esc / Ctrl+[', 'Leave Visual mode'],
  ['registers', '.', 'Repeat the last change'],
  ['registers', '"{register}', 'Use a register for the next delete, yank or paste'],
  ['registers', '"_', 'Black hole register: discard what is deleted'],
  ['registers', '"+ / "*', 'System clipboard register'],
  ['registers', '"A-"Z', 'Append to the named register'],
  ['registers', '"0', 'The last yank'],
  ['registers', '"1-"9', 'The last deletes of a line or more, newest first'],
  ['registers', '"-', 'The last delete within a single line'],
  ['editing', 'r{char}', 'Replace the character under the cursor'],
  ['editing', 'Esc / Ctrl+[', 'Leave Insert mode'],
  ['window', 'Ctrl+E', 'Scroll the window down by lines'],
  ['window', 'Ctrl+Y', 'Scroll the window up by lines'],
]

/** Drop later rows that repeat an earlier (group, keys) pair. */
function dedupeRows(rows: VimKeyHelpRow[]): VimKeyHelpRow[] {
  return rows.filter((row, index) => {
    return rows.findIndex((other) => other.keys === row.keys && other.group === row.group) === index
  })
}

/**
 * Every row before de-duplication, so a test can tell that two registries claim the same
 * keys (a real conflict) instead of the dedupe quietly hiding it.
 */
export function collectVimKeyHelpRows(): VimKeyHelpRow[] {
  const group = groups()
  const rows: VimKeyHelpRow[] = []
  const add = (target: string, keys: string, description: string): void => {
    rows.push({ group: target, keys, description: describeVimKeyHelp(description) })
  }

  for (const motion of VIM_MOTIONS) {
    const keys =
      motion.helpKeys ??
      motion.keys.map((key) => (motion.needsChar === true ? `${key}{char}` : key)).join(' / ')
    if (keys !== '') add(group.motions, keys, motion.description)
  }

  for (const operator of VIM_OPERATORS) {
    const keys = `${operator.prefix ?? ''}${operator.key}`
    add(group.operators, `${keys}{motion}`, operator.description)
    add(group.operators, `${keys}${operator.key}`, operator.description)
  }

  for (const object of VIM_TEXT_OBJECTS) {
    const keys = object.keys.join(' / ')
    add(group.textObjects, `i${keys.replace(/ \/ /g, ' / i')}`, `Inner ${object.description}`)
    add(group.textObjects, `a${keys.replace(/ \/ /g, ' / a')}`, `Around ${object.description}`)
  }

  for (const [prefix, table] of Object.entries(PREFIX_TABLES)) {
    for (const [key, entry] of table.entries) {
      if ('motion' in entry || 'operator' in entry) continue
      const target = prefix === 'z' ? group.window : group.goto
      add(target, `${prefix}${key}`, entry.description)
    }
  }

  for (const [key, command] of SIMPLE_COMMANDS) {
    const searching = '/?nN*#'.includes(key)
    add(searching ? group.search : group.editing, key, command.description)
  }
  for (const [key, command] of CTRL_COMMANDS) {
    // Navigation-history jumps belong with the other "go to" keys.
    const target = command.create(1).type === 'platform-command' ? group.goto : group.editing
    add(target, `Ctrl+${key.toUpperCase()}`, command.description)
  }

  for (const [key, def] of VISUAL_ACTION_KEYS) add(group.visual, key, def.description)
  for (const [key, def] of VISUAL_G_ACTION_KEYS) add(group.visual, `g${key}`, def.description)

  for (const [target, keys, description] of EXTRA_ROWS) add(group[target], keys, description)

  return rows
}

/** Every editor Vim binding, grouped, with localized descriptions. */
export function getVimEditorKeyHelp(): VimKeyHelpRow[] {
  return dedupeRows(collectVimKeyHelpRows())
}

/** The English descriptions behind `getVimEditorKeyHelp`, for translation coverage checks. */
export function listVimKeyHelpDescriptions(): string[] {
  const descriptions = new Set<string>()
  const collect = (description: string): void => {
    descriptions.add(description)
  }
  for (const motion of VIM_MOTIONS) collect(motion.description)
  for (const operator of VIM_OPERATORS) collect(operator.description)
  for (const object of VIM_TEXT_OBJECTS) {
    collect(`Inner ${object.description}`)
    collect(`Around ${object.description}`)
  }
  for (const table of Object.values(PREFIX_TABLES)) {
    for (const entry of table.entries.values()) {
      if ('description' in entry) collect(entry.description)
    }
  }
  for (const command of SIMPLE_COMMANDS.values()) collect(command.description)
  for (const command of CTRL_COMMANDS.values()) collect(command.description)
  for (const def of VISUAL_ACTION_KEYS.values()) collect(def.description)
  for (const def of VISUAL_G_ACTION_KEYS.values()) collect(def.description)
  for (const [, , description] of EXTRA_ROWS) collect(description)
  return [...descriptions]
}
