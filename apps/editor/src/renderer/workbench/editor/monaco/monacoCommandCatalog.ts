/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Static catalog of commonly used Monaco editor built-in commands.
 *  Used to register them in CommandsRegistry (for display in KeybindingsEditor)
 *  and to drive the keybinding bridge in FileEditor.
 *
 *  Command IDs correspond to Monaco's internal command registry as exposed via
 *  IStandaloneCodeEditor.trigger(source, handlerId, payload).
 *--------------------------------------------------------------------------------------------*/

export interface IMonacoCommandDescriptor {
  id: string
  label: string
  category: 'Editor'
  /** Platform-neutral default keybinding, e.g. 'ctrl+f'. Windows/Linux focused. */
  defaultKey?: string
}

export const MONACO_COMMAND_CATALOG: readonly IMonacoCommandDescriptor[] = [
  // Editing
  { id: 'undo', label: 'Undo', category: 'Editor', defaultKey: 'ctrl+z' },
  { id: 'redo', label: 'Redo', category: 'Editor', defaultKey: 'ctrl+y' },
  { id: 'editor.action.selectAll', label: 'Select All', category: 'Editor', defaultKey: 'ctrl+a' },
  {
    id: 'editor.action.deleteLines',
    label: 'Delete Line',
    category: 'Editor',
    defaultKey: 'ctrl+shift+k',
  },
  {
    id: 'editor.action.moveLinesUpAction',
    label: 'Move Line Up',
    category: 'Editor',
    defaultKey: 'alt+arrowup',
  },
  {
    id: 'editor.action.moveLinesDownAction',
    label: 'Move Line Down',
    category: 'Editor',
    defaultKey: 'alt+arrowdown',
  },
  {
    id: 'editor.action.copyLinesUpAction',
    label: 'Copy Line Up',
    category: 'Editor',
    defaultKey: 'shift+alt+arrowup',
  },
  {
    id: 'editor.action.copyLinesDownAction',
    label: 'Copy Line Down',
    category: 'Editor',
    defaultKey: 'shift+alt+arrowdown',
  },

  // Search
  { id: 'actions.find', label: 'Find', category: 'Editor', defaultKey: 'ctrl+f' },
  {
    id: 'editor.action.startFindReplaceAction',
    label: 'Replace',
    category: 'Editor',
    defaultKey: 'ctrl+h',
  },

  // Code editing
  {
    id: 'editor.action.commentLine',
    label: 'Toggle Line Comment',
    category: 'Editor',
    defaultKey: 'ctrl+/',
  },
  {
    id: 'editor.action.blockComment',
    label: 'Toggle Block Comment',
    category: 'Editor',
    defaultKey: 'shift+alt+a',
  },
  {
    id: 'editor.action.indentLines',
    label: 'Indent Lines',
    category: 'Editor',
    defaultKey: 'ctrl+]',
  },
  {
    id: 'editor.action.outdentLines',
    label: 'Outdent Lines',
    category: 'Editor',
    defaultKey: 'ctrl+[',
  },
  {
    id: 'editor.action.formatDocument',
    label: 'Format Document',
    category: 'Editor',
    defaultKey: 'shift+alt+f',
  },
  {
    id: 'editor.action.triggerSuggest',
    label: 'Trigger Suggest',
    category: 'Editor',
    defaultKey: 'ctrl+space',
  },
  {
    id: 'editor.action.triggerParameterHints',
    label: 'Trigger Parameter Hints',
    category: 'Editor',
    defaultKey: 'ctrl+shift+space',
  },

  // Navigation / symbols
  { id: 'editor.action.rename', label: 'Rename Symbol', category: 'Editor', defaultKey: 'f2' },
  {
    id: 'editor.action.revealDefinition',
    label: 'Go to Definition',
    category: 'Editor',
    defaultKey: 'f12',
  },
  {
    id: 'editor.action.peekDefinition',
    label: 'Peek Definition',
    category: 'Editor',
    defaultKey: 'alt+f12',
  },
  {
    id: 'editor.action.jumpToBracket',
    label: 'Jump to Bracket',
    category: 'Editor',
    defaultKey: 'ctrl+shift+\\',
  },

  // Multi-cursor / selection
  {
    id: 'editor.action.addSelectionToNextFindMatch',
    label: 'Add Selection to Next Match',
    category: 'Editor',
    defaultKey: 'ctrl+d',
  },
  {
    id: 'editor.action.selectHighlights',
    label: 'Select All Occurrences',
    category: 'Editor',
    defaultKey: 'ctrl+shift+l',
  },
  {
    id: 'editor.action.insertCursorAbove',
    label: 'Add Cursor Above',
    category: 'Editor',
    defaultKey: 'ctrl+alt+arrowup',
  },
  {
    id: 'editor.action.insertCursorBelow',
    label: 'Add Cursor Below',
    category: 'Editor',
    defaultKey: 'ctrl+alt+arrowdown',
  },
]

/** Fast membership test for bridge lookup. */
export const MONACO_COMMAND_IDS: ReadonlySet<string> = new Set(
  MONACO_COMMAND_CATALOG.map((c) => c.id),
)

/** Normalizes a key string to lowercase with sorted modifier order: ctrl+alt+shift+meta+<key>. */
export function normalizeKey(key: string): string {
  const parts = key
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
  const modifiers = new Set(['ctrl', 'alt', 'shift', 'meta'])
  const mods = parts.filter((p) => modifiers.has(p)).sort()
  const rest = parts.filter((p) => !modifiers.has(p))
  return [...mods, ...rest].join('+')
}

/** Builds a platform-neutral key string from a DOM KeyboardEvent. */
export function buildKeyStringFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  if (e.metaKey) parts.push('meta')
  parts.push(e.key.toLowerCase())
  return parts.join('+')
}
