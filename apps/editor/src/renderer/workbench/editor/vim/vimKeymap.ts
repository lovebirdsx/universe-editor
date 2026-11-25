/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Normal/Insert/Visual reducer. Pure: it turns one keystroke plus the previous
 *  state into the next state and at most one command. Insert mode passes everything
 *  except Escape / Ctrl+[ through untouched; Normal and Visual mode swallow every
 *  printable key so a stray letter never reaches the buffer, even when it maps to no
 *  command (such keys are reported through `VimKeyResult.unsupported`).
 *
 *  Everything key-specific is table-driven, so a new binding is one entry:
 *  - motion keys         → `VIM_MOTIONS` in vimMotions.ts (looked up here, no key list)
 *  - operator keys       → `VIM_OPERATORS` in vimOperators.ts
 *  - text objects        → `VIM_TEXT_OBJECTS` in vimTextObjects.ts (after `i` / `a`)
 *  - multi-key prefixes  → `PREFIX_STARTERS` + `PREFIX_TABLES` below
 *  - single-key commands → `SIMPLE_COMMANDS` / `CTRL_COMMANDS` below
 *  - Visual-mode actions → `VISUAL_ACTION_KEYS` in vimVisual.ts
 *--------------------------------------------------------------------------------------------*/

import { accumulateCount, isCountDigitKey, isFunctionKeyName } from './vimKeyUtils.js'
import { findVimMotionByKey } from './vimMotions.js'
import { findVimOperatorByKey, getVimOperator, prefixedVimOperators } from './vimOperators.js'
import { isValidVimRegisterName } from './vimRegisters.js'
import { findVimTextObjectByKey } from './vimTextObjects.js'
import { VISUAL_ACTION_KEYS, VISUAL_G_ACTION_KEYS } from './vimVisual.js'
import {
  isVisualMode,
  type VimCommand,
  type VimFindMotion,
  type VimInsertPlacement,
  type VimKeyInput,
  type VimKeyResult,
  type VimMotion,
  type VimOperator,
  type VimPending,
  type VimPendingKind,
  type VimState,
  type VimVisualMode,
} from './vimTypes.js'

/**
 * `event.key` names for the navigation keys, mapped to their Vim equivalent.
 * Without this they would fall into the Normal-mode "swallow unexpected keys"
 * branch and never reach Monaco (arrows/HOME/END would simply do nothing).
 */
export const NAVIGATION_MOTIONS = new Map<string, VimMotion>([
  ['ArrowLeft', 'h'],
  ['ArrowRight', 'l'],
  ['ArrowUp', 'k'],
  ['ArrowDown', 'j'],
  ['Home', '0'],
  ['End', '$'],
  ['PageUp', 'pageUp'],
  ['PageDown', 'pageDown'],
])

/** Lone modifier presses are not commands: they must neither run nor cancel a pending prefix. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
])

/**
 * Clear every in-flight prefix (count, operator, `g…`, register) but keep what
 * outlives a command: the mode. The one way to "start over", used by the reducer
 * and by the controller on focus loss.
 */
export function idle(state: VimState): VimState {
  return {
    ...state,
    count: 0,
    operatorCount: 0,
    pendingOperator: null,
    pending: null,
    register: null,
  }
}

/**
 * Vim multiplies the counts around an operator: `2d3w` is `d6w`. Without an
 * operator only `count` is ever set. 0 still means "none typed".
 */
export function effectiveCount(state: VimState): number {
  if (state.operatorCount > 0 && state.count > 0) return state.operatorCount * state.count
  return state.operatorCount > 0 ? state.operatorCount : state.count
}

/** A command ends the in-flight prefix; leaving Visual is the reducer's job too. */
function emit(state: VimState, command: VimCommand, mode?: VimState['mode']): VimKeyResult {
  const next = idle(state)
  return {
    state: mode === undefined ? next : { ...next, mode },
    command,
    handled: true,
    register: state.register,
  }
}

/** Consume the stroke, run nothing, drop any pending prefix. */
function swallow(state: VimState): VimKeyResult {
  return { state: idle(state), command: null, handled: true, register: null }
}

/** Swallowed because Vim has no command for it; the controller reports the key. */
function unsupported(state: VimState, key: string): VimKeyResult {
  return { ...swallow(state), unsupported: key }
}

/** Leave the stroke to the workbench / Monaco, drop any pending prefix. */
function passthrough(state: VimState): VimKeyResult {
  return { state: idle(state), command: null, handled: false, register: null }
}

/** Keep everything as it was and let the stroke through (lone modifiers). */
function ignore(state: VimState): VimKeyResult {
  return { state, command: null, handled: false, register: null }
}

/** Keep collecting: the stroke is consumed, nothing runs yet. */
function pendingResult(next: VimState): VimKeyResult {
  return { state: next, command: null, handled: true, register: null }
}

/**
 * The fallback for a key no table claims. Unhandled function keys (F-keys, lone
 * modifiers, media keys, IME's `Process`/`Dead`) belong to the workbench and
 * Monaco — swallowing them would break F2/F12 and friends. Printable input stays
 * swallowed so a stray `q` (or emoji) never types into the buffer.
 */
function unclaimedKey(state: VimState, key: string): VimKeyResult {
  return isFunctionKeyName(key) ? passthrough(state) : unsupported(state, key)
}

/**
 * Keys that edit or move in Monaco if they leak through: while Vim waits for an
 * argument they cancel the pending state and are swallowed (`r<BS>` must not
 * delete a character, `f<CR>` must not insert a line break).
 */
const EDITING_KEYS: ReadonlySet<string> = new Set([
  ...NAVIGATION_MOTIONS.keys(),
  'Backspace',
  'Delete',
  'Enter',
  'Tab',
  'Insert',
])

/**
 * The character a key types as an `f`/`r` argument, or null when it is not one.
 * `<Tab>` is a tab character; `<CR>` is a line break only where the caller allows it (`r`).
 */
function argumentChar(key: string, allowEnter: boolean): string | null {
  if (key === 'Tab') return '\t'
  if (key === 'Enter') return allowEnter ? '\n' : null
  return isTypedCharacter(key) ? key : null
}

/** An argument key that is no character: editing keys cancel, anything else follows `unclaimedKey`. */
function badArgumentKey(state: VimState, key: string): VimKeyResult {
  return EDITING_KEYS.has(key) ? swallow(state) : unclaimedKey(state, key)
}

/**
 * Whether the next key is consumed as the argument of `f`/`t`/`r`/`"`/`i`/`a`.
 * The dispatcher asks so the leader key (Space) types `r<Space>` instead of
 * starting a leader sequence.
 */
export function isAwaitingCharArg(state: VimState): boolean {
  const pending = state.pending
  return (
    pending !== null &&
    (pending.kind === 'find' ||
      pending.kind === 'replace' ||
      pending.kind === 'register' ||
      pending.kind === 'textobject')
  )
}

/** The prefix key behind a pending state, or null for the argument-taking kinds. */
function prefixKindOf(pending: VimPending): VimPendingKind | null {
  switch (pending.kind) {
    case 'find':
    case 'replace':
    case 'register':
    case 'textobject':
      return null
    default:
      return pending.kind
  }
}

function motion(state: VimState, id: VimMotion, char?: string): VimKeyResult {
  const count = effectiveCount(state)
  const extra = char === undefined ? {} : { char }
  if (state.pendingOperator !== null) {
    return emit(state, {
      type: 'operator',
      operator: state.pendingOperator,
      motion: id,
      count,
      ...extra,
    })
  }
  return emit(state, { type: 'motion', motion: id, count, ...extra })
}

/** Ctrl strokes the editor Vim core owns as viewport movement. */
export function isVimViewportStroke(e: {
  readonly key: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey?: boolean
}): boolean {
  // Shift variants are different commands (`Ctrl+Shift+F` = Find in Files,
  // `Ctrl+Shift+U` = Output, Linux `Ctrl+Shift+D` = Copy Line Down) and stay
  // with the workbench.
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey === true) return false
  const key = e.key.toLowerCase()
  return key === 'f' || key === 'b' || key === 'd' || key === 'u' || key === 'e' || key === 'y'
}

export function pagingMotion(key: string): VimMotion {
  switch (key.toLowerCase()) {
    case 'f':
      return 'pageDown'
    case 'b':
      return 'pageUp'
    case 'd':
      return 'halfPageDown'
    default:
      return 'halfPageUp'
  }
}

/** `Escape`, or `Ctrl+[` — the terminal-era alias every Vim user's fingers know. */
function isEscapeStroke(input: VimKeyInput): boolean {
  if (input.alt || input.meta) return false
  if (input.key === 'Escape') return !input.ctrl
  return input.ctrl && input.key === '['
}

/**
 * Resolve a multi-character `event.key` (arrows, Home/End, PageUp/PageDown,
 * Backspace/Delete/Enter). Returns `null` for keys the reducer does not own —
 * F-keys, lone modifiers, media keys, IME's `Process`/`Dead` — which must keep
 * bubbling to the workbench and Monaco.
 */
function functionalKeyResult(state: VimState, key: string): VimKeyResult | null {
  const navigation = NAVIGATION_MOTIONS.get(key)
  if (navigation !== undefined) return motion(state, navigation)

  switch (key) {
    case 'Backspace':
      // Vim's `<BS>` is a synonym for `h`.
      return motion(state, 'h')
    case 'Enter':
      // Vim's `<CR>` (`+`): down one line onto the first non-blank.
      return motion(state, 'enter')
    case 'Delete':
      // Vim's `<Del>` deletes under the cursor, like `x` (not meaningful in Visual: it deletes).
      if (isVisualMode(state.mode)) return emit(state, visualDelete(state), 'normal')
      // `d<Del>` is not a motion: cancel the operator instead of deleting a character.
      if (state.pendingOperator !== null) return swallow(state)
      return emit(state, {
        type: 'delete-char',
        count: Math.max(1, effectiveCount(state)),
        backward: false,
      })
    case 'Tab':
    case 'Insert':
      return swallow(state)
    default:
      return null
  }
}

function visualDelete(state: VimState): VimCommand {
  return { type: 'visual-action', action: 'delete', count: Math.max(1, effectiveCount(state)) }
}

/** What a prefix's second key does: resolve as a motion (so operators apply), run a command, or start an operator. */
export type VimPrefixEntry =
  | { readonly motion: VimMotion }
  | {
      readonly command: (count: number) => VimCommand
      readonly description: string
      /** Meaningless after an operator (`dgJ`): cancels it instead of running. */
      readonly noOperator?: true
    }
  | { readonly operator: VimOperator }

interface VimPrefixTable {
  readonly entries: ReadonlyMap<string, VimPrefixEntry>
  /** False: the prefix cancels a pending operator (`dz` is not a command). */
  readonly allowedWithOperator: boolean
}

const editorCommand = (commandId: string, description: string): VimPrefixEntry => ({
  command: () => ({ type: 'editor-command', commandId }),
  description,
})

/** `z` + key fold commands that map straight to a Monaco editor action. */
const Z_FOLD_COMMANDS: readonly (readonly [string, string, string])[] = [
  ['o', 'editor.unfold', 'Open the fold under the cursor'],
  ['O', 'editor.unfoldRecursively', 'Open the fold and its children'],
  ['c', 'editor.fold', 'Close the fold under the cursor'],
  ['C', 'editor.foldRecursively', 'Close the fold and its children'],
  ['a', 'editor.toggleFold', 'Toggle the fold under the cursor'],
  ['A', 'editor.toggleFoldRecursively', 'Toggle the fold and its children'],
  ['M', 'editor.foldAll', 'Close all folds'],
  ['R', 'editor.unfoldAll', 'Open all folds'],
  ['j', 'editor.gotoNextFold', 'Move to the next fold'],
  ['k', 'editor.gotoPreviousFold', 'Move to the previous fold'],
]

function revealEntry(at: 'top' | 'center' | 'bottom', description: string): VimPrefixEntry {
  // A count is a line number (`[count]zt`), not a repetition.
  return {
    command: (count) => ({ type: 'reveal-line', at, line: count > 0 ? count : null }),
    description,
  }
}

function bracketTable(prefix: '[' | ']'): VimPrefixTable {
  const forward = prefix === ']'
  return {
    allowedWithOperator: true,
    entries: new Map<string, VimPrefixEntry>([
      [
        'd',
        editorCommand(
          forward ? 'editor.action.marker.nextInFiles' : 'editor.action.marker.prevInFiles',
          forward ? 'Next diagnostic' : 'Previous diagnostic',
        ),
      ],
      [
        'c',
        {
          command: (count) => ({
            type: 'platform-command',
            commandId: forward
              ? 'workbench.action.editor.nextChange'
              : 'workbench.action.editor.previousChange',
            count: Math.max(1, count),
          }),
          description: forward ? 'Next change (diff)' : 'Previous change (diff)',
        },
      ],
      [
        'z',
        {
          command: () => ({ type: 'fold-goto', edge: forward ? 'end' : 'start' }),
          description: forward ? 'End of the current fold' : 'Start of the current fold',
        },
      ],
    ]),
  }
}

/** Second-key tables for each multi-key prefix. */
export const PREFIX_TABLES: Record<VimPendingKind, VimPrefixTable> = {
  g: {
    allowedWithOperator: true,
    entries: new Map<string, VimPrefixEntry>([
      ['g', { motion: 'gg' }],
      ['j', { motion: 'gj' }],
      ['k', { motion: 'gk' }],
      ['d', editorCommand('editor.action.revealDefinition', 'Go to definition')],
      ['D', editorCommand('editor.action.revealDeclaration', 'Go to declaration')],
      ['y', editorCommand('editor.action.goToTypeDefinition', 'Go to type definition')],
      ['i', editorCommand('editor.action.goToImplementation', 'Go to implementation')],
      ['r', editorCommand('editor.action.goToReferences', 'Go to references')],
      ['R', editorCommand('editor.action.referenceSearch.trigger', 'Find references')],
      ['h', editorCommand('editor.action.showHover', 'Show hover')],
      [
        'J',
        {
          command: (count) => ({
            type: 'join-lines',
            count: Math.max(1, count),
            keepSpacing: true,
          }),
          description: 'Join lines without inserting spaces',
          noOperator: true,
        },
      ],
      [
        'I',
        {
          command: (count) => insertCommand('first-column')(count),
          description: 'Insert at column 1',
          noOperator: true,
        },
      ],
      [
        'v',
        {
          command: () => ({ type: 'visual-reselect' }),
          description: 'Reselect the previous Visual area',
          noOperator: true,
        },
      ],
      ...prefixedVimOperators('g').map(
        (operator) => [operator.key, { operator: operator.id }] as const,
      ),
    ]),
  },
  z: {
    allowedWithOperator: false,
    entries: new Map<string, VimPrefixEntry>([
      ['z', revealEntry('center', 'Center the cursor line in the window')],
      ['t', revealEntry('top', 'Put the cursor line at the top of the window')],
      ['b', revealEntry('bottom', 'Put the cursor line at the bottom of the window')],
      ...Z_FOLD_COMMANDS.map(
        ([key, id, description]) => [key, editorCommand(id, description)] as const,
      ),
    ]),
  },
  '[': bracketTable('['),
  ']': bracketTable(']'),
}

/** The key that opens each prefix. */
export const PREFIX_STARTERS: ReadonlyMap<string, VimPendingKind> = new Map<string, VimPendingKind>(
  [
    ['g', 'g'],
    ['z', 'z'],
    ['[', '['],
    [']', ']'],
  ],
)

export interface VimSimpleCommandDef {
  /** `count` is already at least 1. */
  readonly create: (count: number) => VimCommand
  /** One-line help text (English; localized by `vimKeyHelp.ts`). */
  readonly description: string
  /** Also available in Visual mode. */
  readonly visual?: true
}

const insertCommand =
  (placement: VimInsertPlacement) =>
  (count: number): VimCommand =>
    count > 1 ? { type: 'enter-insert', placement, count } : { type: 'enter-insert', placement }

/** Commands a single Normal-mode key emits. */
export const SIMPLE_COMMANDS: ReadonlyMap<string, VimSimpleCommandDef> = new Map<
  string,
  VimSimpleCommandDef
>([
  [
    '/',
    {
      create: (count) => ({ type: 'search-open', direction: 'forward', count }),
      description: 'Search forward',
      visual: true,
    },
  ],
  [
    '?',
    {
      create: (count) => ({ type: 'search-open', direction: 'backward', count }),
      description: 'Search backward',
      visual: true,
    },
  ],
  [
    'n',
    {
      create: (count) => ({ type: 'search-repeat', reverse: false, count }),
      description: 'Next search match',
      visual: true,
    },
  ],
  [
    'N',
    {
      create: (count) => ({ type: 'search-repeat', reverse: true, count }),
      description: 'Previous search match',
      visual: true,
    },
  ],
  [
    '*',
    {
      create: (count) => ({ type: 'search-word', direction: 'forward', count }),
      description: 'Search forward for the word under the cursor',
      visual: true,
    },
  ],
  [
    '#',
    {
      create: (count) => ({ type: 'search-word', direction: 'backward', count }),
      description: 'Search backward for the word under the cursor',
      visual: true,
    },
  ],
  ['i', { create: insertCommand('before'), description: 'Insert before the cursor' }],
  ['a', { create: insertCommand('after'), description: 'Insert after the cursor' }],
  ['I', { create: insertCommand('line-start'), description: 'Insert at the start of the line' }],
  ['A', { create: insertCommand('line-end'), description: 'Insert at the end of the line' }],
  ['o', { create: insertCommand('new-line-below'), description: 'Open a line below' }],
  ['O', { create: insertCommand('new-line-above'), description: 'Open a line above' }],
  [
    'K',
    {
      create: () => ({ type: 'editor-command', commandId: 'editor.action.showHover' }),
      description: 'Show hover',
      visual: true,
    },
  ],
  [
    'C',
    {
      create: (count) => ({ type: 'operator', operator: 'c', motion: '$', count }),
      description: 'Change to the end of the line',
    },
  ],
  [
    'D',
    {
      create: (count) => ({ type: 'operator', operator: 'd', motion: '$', count }),
      description: 'Delete to the end of the line',
    },
  ],
  [
    'Y',
    {
      create: (count) => ({ type: 'linewise', operator: 'y', count }),
      description: 'Yank the line (same as yy)',
    },
  ],
  [
    's',
    {
      create: (count) => ({ type: 'substitute-char', count }),
      description: 'Substitute characters under the cursor',
    },
  ],
  [
    'S',
    {
      create: (count) => ({ type: 'linewise', operator: 'c', count }),
      description: 'Change whole lines',
    },
  ],
  [
    'x',
    {
      create: (count) => ({ type: 'delete-char', count, backward: false }),
      description: 'Delete the character under the cursor',
    },
  ],
  [
    'X',
    {
      create: (count) => ({ type: 'delete-char', count, backward: true }),
      description: 'Delete the character before the cursor',
    },
  ],
  [
    '~',
    {
      create: (count) => ({ type: 'toggle-case', count }),
      description: 'Toggle case of the character under the cursor',
    },
  ],
  [
    'p',
    {
      create: (count) => ({ type: 'paste', count, before: false }),
      description: 'Paste after the cursor',
    },
  ],
  [
    'P',
    {
      create: (count) => ({ type: 'paste', count, before: true }),
      description: 'Paste before the cursor',
    },
  ],
  ['u', { create: () => ({ type: 'undo' }), description: 'Undo' }],
  ['J', { create: (count) => ({ type: 'join-lines', count }), description: 'Join lines' }],
  [
    'H',
    {
      create: (count) => ({ type: 'goto-viewport-line', at: 'top', count }),
      description: 'Top of the window',
      visual: true,
    },
  ],
  [
    'M',
    {
      create: (count) => ({ type: 'goto-viewport-line', at: 'middle', count }),
      description: 'Middle of the window',
      visual: true,
    },
  ],
  [
    'L',
    {
      create: (count) => ({ type: 'goto-viewport-line', at: 'bottom', count }),
      description: 'Bottom of the window',
      visual: true,
    },
  ],
])

/** `Ctrl+<key>` commands in Normal mode; the workbench loses these chords while Vim is in Normal. */
export const CTRL_COMMANDS: ReadonlyMap<string, VimSimpleCommandDef> = new Map<
  string,
  VimSimpleCommandDef
>([
  ['r', { create: () => ({ type: 'redo' }), description: 'Redo' }],
  [
    'o',
    {
      create: (count) => ({
        type: 'platform-command',
        commandId: 'workbench.action.goBack',
        count,
      }),
      description: 'Jump back in the navigation history',
    },
  ],
  [
    'i',
    {
      create: (count) => ({
        type: 'platform-command',
        commandId: 'workbench.action.goForward',
        count,
      }),
      description: 'Jump forward in the navigation history',
    },
  ],
])

const VISUAL_ENTER_KEYS: ReadonlyMap<string, VimVisualMode> = new Map<string, VimVisualMode>([
  ['v', 'visual'],
  ['V', 'visual-line'],
])

function isTypedCharacter(key: string): boolean {
  return key.length > 0 && !isFunctionKeyName(key)
}

function visualCommandFor(state: VimState, key: string, g: boolean): VimKeyResult | null {
  const def = (g ? VISUAL_G_ACTION_KEYS : VISUAL_ACTION_KEYS).get(key)
  if (def === undefined) return null
  if (def.needsChar === true) {
    return pendingResult({ ...state, pending: { kind: 'replace' } })
  }
  return emit(
    state,
    {
      type: 'visual-action',
      action: def.action,
      count: Math.max(1, effectiveCount(state)),
      ...(def.linewise === true ? { linewise: true as const } : {}),
      ...(def.toEol === true ? { toEol: true as const } : {}),
    },
    'normal',
  )
}

function resolvePrefixKey(state: VimState, kind: VimPendingKind, key: string): VimKeyResult {
  const visual = isVisualMode(state.mode)
  if (visual && kind === 'g') {
    const action = visualCommandFor(state, key, true)
    if (action !== null) return action
  }
  const entry = PREFIX_TABLES[kind].entries.get(key)
  if (entry === undefined) return unclaimedKey(state, key)
  if ('motion' in entry) return motion(state, entry.motion)
  if ('operator' in entry) {
    if (visual) return unsupported(state, key)
    if (state.pendingOperator === entry.operator) {
      return emit(state, {
        type: 'linewise',
        operator: entry.operator,
        count: Math.max(1, effectiveCount(state)),
      })
    }
    if (state.pendingOperator !== null) return unsupported(state, key)
    return pendingResult({
      ...state,
      pending: null,
      pendingOperator: entry.operator,
      operatorCount: state.count,
      count: 0,
    })
  }
  if (entry.noOperator === true && state.pendingOperator !== null) return unsupported(state, key)
  return emit(state, entry.command(effectiveCount(state)))
}

/** Second key of `f`/`r`/`"`/`i`/`a`, which take a typed character instead of a table lookup. */
function resolveTypedKey(state: VimState, key: string): VimKeyResult | null {
  const pending = state.pending
  if (pending === null) return null
  switch (pending.kind) {
    case 'find': {
      const char = argumentChar(key, false)
      return char === null ? badArgumentKey(state, key) : motion(state, pending.motion, char)
    }
    case 'replace': {
      const char = argumentChar(key, true)
      if (char === null) return badArgumentKey(state, key)
      if (isVisualMode(state.mode)) {
        return emit(
          state,
          {
            type: 'visual-action',
            action: 'replace',
            char,
            count: Math.max(1, effectiveCount(state)),
          },
          'normal',
        )
      }
      return emit(state, {
        type: 'replace-char',
        char,
        count: Math.max(1, effectiveCount(state)),
      })
    }
    case 'register':
      if (!isValidVimRegisterName(key)) return badArgumentKey(state, key)
      // `""` is the unnamed register: the same as no register, so it also mirrors to the clipboard.
      return pendingResult({ ...state, pending: null, register: key === '"' ? null : key })
    case 'textobject': {
      const object = findVimTextObjectByKey(key)
      if (object === undefined) return badArgumentKey(state, key)
      const count = Math.max(1, effectiveCount(state))
      if (isVisualMode(state.mode)) {
        return emit(state, {
          type: 'visual-textobject',
          object: object.id,
          around: pending.around,
          count,
        })
      }
      if (state.pendingOperator === null) return badArgumentKey(state, key)
      return emit(state, {
        type: 'operator-textobject',
        operator: state.pendingOperator,
        object: object.id,
        around: pending.around,
        count,
      })
    }
    default:
      return null
  }
}

/** Keys specific to Visual mode, after the prefix/count/register machinery has had its turn. */
function reduceVisualKey(state: VimState, key: string): VimKeyResult {
  const enter = VISUAL_ENTER_KEYS.get(key)
  if (enter !== undefined) {
    return state.mode === enter
      ? emit(state, { type: 'visual-exit' }, 'normal')
      : emit(state, { type: 'visual-enter', mode: enter }, enter)
  }
  if (key === 'o' || key === 'O') {
    return emit(state, { type: 'visual-swap', corner: key === 'o' }, state.mode)
  }
  if (key === 'i' || key === 'a') {
    return pendingResult({ ...state, pending: { kind: 'textobject', around: key === 'a' } })
  }
  if ((key === 'I' || key === 'A') && state.mode === 'visual-block') {
    return emit(state, { type: 'visual-block-insert', at: key === 'I' ? 'start' : 'end' }, 'normal')
  }
  const action = visualCommandFor(state, key, false)
  if (action !== null) return action

  const motionDef = findVimMotionByKey(key)
  if (motionDef !== undefined) {
    if (motionDef.needsChar === true) {
      return pendingResult({
        ...state,
        pending: { kind: 'find', motion: motionDef.id as VimFindMotion },
      })
    }
    return motion(state, motionDef.id)
  }
  const command = SIMPLE_COMMANDS.get(key)
  if (command?.visual === true) {
    return emit(state, command.create(Math.max(1, effectiveCount(state))), state.mode)
  }
  return unclaimedKey(state, key)
}

export function reduceVimKey(state: VimState, input: VimKeyInput): VimKeyResult {
  if (state.mode === 'insert') {
    if (isEscapeStroke(input)) {
      return {
        state: { ...idle(state), mode: 'normal' },
        command: { type: 'exit-insert' },
        handled: true,
        register: null,
      }
    }
    return { state, command: null, handled: false, register: null }
  }

  const visual = isVisualMode(state.mode)

  if (isEscapeStroke(input)) {
    const hadPending =
      state.count > 0 ||
      state.operatorCount > 0 ||
      state.pendingOperator !== null ||
      state.pending !== null ||
      state.register !== null
    if (visual) {
      // A first Escape cancels what is in flight; with nothing in flight it leaves Visual.
      return hadPending
        ? swallow(state)
        : {
            state: { ...idle(state), mode: 'normal' },
            command: { type: 'visual-exit' },
            handled: true,
            register: null,
          }
    }
    // Vim's Normal-mode `<Esc>` is also `:nohlsearch`. A bare Esc (nothing in
    // flight) lets the controller drop highlights, or hand focus to the tab
    // strip when there is nothing to drop; an Esc that cancels a prefix is spent.
    return {
      state: idle(state),
      command: hadPending ? null : { type: 'search-highlight-clear' },
      handled: true,
      register: null,
    }
  }

  if (MODIFIER_KEYS.has(input.key)) return ignore(state)

  if (input.ctrl && !input.alt && !input.meta) {
    if (
      isVimViewportStroke({
        key: input.key,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: input.shift,
      })
    ) {
      const key = input.key.toLowerCase()
      if (key === 'e' || key === 'y') {
        return emit(state, {
          type: 'scroll-viewport',
          direction: key === 'e' ? 'down' : 'up',
          count: Math.max(1, effectiveCount(state)),
        })
      }
      return emit(state, {
        type: 'motion',
        motion: pagingMotion(input.key),
        count: effectiveCount(state),
      })
    }
    if (!input.shift && input.key.toLowerCase() === 'v') {
      return state.mode === 'visual-block'
        ? emit(state, { type: 'visual-exit' }, 'normal')
        : emit(state, { type: 'visual-enter', mode: 'visual-block' }, 'visual-block')
    }
    const ctrlCommand = input.shift ? undefined : CTRL_COMMANDS.get(input.key.toLowerCase())
    if (ctrlCommand !== undefined && !visual) {
      return emit(state, ctrlCommand.create(Math.max(1, effectiveCount(state))))
    }
    // Any other modified stroke aborts a pending operator/count (Vim: only a
    // motion or a count may follow an operator).
    return passthrough(state)
  }
  if (input.alt || input.meta) return passthrough(state)

  const key = input.key

  // Typed-character prefixes come first: `Enter` after `r` is a character, not a motion.
  const typed = resolveTypedKey(state, key)
  if (typed !== null) return typed

  // `g<BS>` / `z<Del>`: an editing key cannot finish a prefix, and must not act on its own either.
  if (state.pending !== null && EDITING_KEYS.has(key)) return swallow(state)

  const functional = functionalKeyResult(state, key)
  if (functional !== null) return functional

  const prefix = state.pending === null ? null : prefixKindOf(state.pending)
  if (prefix !== null) return resolvePrefixKey(state, prefix, key)

  const prefixKind = PREFIX_STARTERS.get(key)
  if (prefixKind !== undefined) {
    if (state.pendingOperator !== null && !PREFIX_TABLES[prefixKind].allowedWithOperator) {
      return unsupported(state, key)
    }
    return pendingResult({ ...state, pending: { kind: prefixKind } })
  }

  // A count starts with 1-9; `0` is a digit only once a count has started
  // (`10j`, `d10w`), otherwise it is the line-start motion (`3d0` included —
  // the operator's own count lives in `operatorCount`).
  if (isCountDigitKey(key) || (key === '0' && state.count > 0)) {
    return pendingResult({ ...state, count: accumulateCount(state.count, Number(key)) })
  }

  if (key === '"') {
    if (state.pendingOperator !== null) return unsupported(state, key)
    return pendingResult({ ...state, pending: { kind: 'register' } })
  }

  if (visual) return reduceVisualKey(state, key)

  if (key === '.') {
    if (state.pendingOperator !== null) return unsupported(state, key)
    return emit(state, { type: 'repeat-change', count: effectiveCount(state) })
  }

  const enterVisual = VISUAL_ENTER_KEYS.get(key)
  if (enterVisual !== undefined) {
    if (state.pendingOperator !== null) return unsupported(state, key)
    return emit(state, { type: 'visual-enter', mode: enterVisual }, enterVisual)
  }

  if (state.pendingOperator !== null) {
    const pendingDef = getVimOperator(state.pendingOperator)
    // Doubling the operator key (`dd`, `gUU`) works on whole lines.
    if (pendingDef.key === key) {
      return emit(state, {
        type: 'linewise',
        operator: pendingDef.id,
        count: Math.max(1, effectiveCount(state)),
      })
    }
    if (key === 'i' || key === 'a') {
      return pendingResult({ ...state, pending: { kind: 'textobject', around: key === 'a' } })
    }
  }

  const operator = findVimOperatorByKey(key)
  if (operator !== undefined) {
    // A second, different operator (`dy`) is not a command.
    if (state.pendingOperator !== null) return unsupported(state, key)
    return pendingResult({
      ...state,
      pendingOperator: operator.id,
      operatorCount: state.count,
      count: 0,
    })
  }

  const motionDef = findVimMotionByKey(key)
  if (motionDef !== undefined) {
    if (motionDef.needsChar === true) {
      return pendingResult({
        ...state,
        pending: { kind: 'find', motion: motionDef.id as VimFindMotion },
      })
    }
    return motion(state, motionDef.id)
  }

  // Past this point only whole commands remain, and none of them takes an
  // operator (`d/`, `dn`, `dH`, `dx` all cancel).
  if (state.pendingOperator !== null) return unclaimedKey(state, key)

  if (key === 'r') return pendingResult({ ...state, pending: { kind: 'replace' } })

  const command = SIMPLE_COMMANDS.get(key)
  if (command !== undefined) return emit(state, command.create(Math.max(1, effectiveCount(state))))

  return unclaimedKey(state, key)
}

const OPERATOR_DISPLAY: Record<VimOperator, string> = {
  d: 'd',
  y: 'y',
  c: 'c',
  '>': '>',
  '<': '<',
  'g~': 'g~',
  gu: 'gu',
  gU: 'gU',
}

/** The keys typed so far, in the order Vim shows them (`"a2d3`, `g`, `ci`): empty when idle. */
export function formatPendingKeys(state: VimState): string {
  let text = ''
  if (state.register !== null) text += `"${state.register}`
  if (state.pendingOperator === null) {
    if (state.count > 0) text += String(state.count)
  } else {
    if (state.operatorCount > 0) text += String(state.operatorCount)
    text += OPERATOR_DISPLAY[state.pendingOperator]
    if (state.count > 0) text += String(state.count)
  }
  const pending = state.pending
  if (pending !== null) {
    switch (pending.kind) {
      case 'find':
        text += pending.motion
        break
      case 'replace':
        text += 'r'
        break
      case 'register':
        text += '"'
        break
      case 'textobject':
        text += pending.around ? 'a' : 'i'
        break
      default:
        text += pending.kind
    }
  }
  return text
}
