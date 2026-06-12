/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoActionsBridge — at MonacoLoader bootstrap time, enumerate every
 *  EditorAction registered with monaco's internal EditorContributionRegistry
 *  (find, replace, formatDocument, rename, …), plus a small hand-listed set
 *  of core editor commands (undo / redo / selectAll) that monaco registers
 *  outside that registry, and mirror them into our own CommandsRegistry so
 *  the Keyboard Shortcuts editor can list and rebind them.
 *
 *  Their *default* keybindings are intentionally NOT registered with our
 *  KeybindingsRegistry — they're recorded in a side-table accessible via
 *  `getMonacoDefaultKeybinding(id)`. That keeps monaco's own
 *  context-aware keybinding dispatch in charge of the default keys (so
 *  ESC inside a find widget still cancels the widget, IntelliSense's ESC
 *  still dismisses the popup, etc.). When a user *overrides* a binding,
 *  that override goes through KeybindingsRegistry as usual, and
 *  FileEditor's capture-phase bridge prevents monaco from also acting on
 *  the *original* default key.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  IEditorGroupsService,
  INotificationService,
  combinedDisposable,
  markAsSingleton,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../../services/editor/FileEditorRegistry.js'
import {
  decodeMonacoKeybinding,
  decodedToRegistryKeyString,
  MASK_CTRLCMD,
  TOKEN_TO_KEYCODE,
  type DecodedKeybinding,
} from './monacoKeybindingDecoder.js'

interface IMonacoEditorAction {
  readonly id: string
  readonly label: string
  // `_kbOpts` is the private field set by Command#constructor.
  readonly _kbOpts?: { primary?: number } | readonly { primary?: number }[]
}

export interface IMonacoEditorExtensionsRegistry {
  getEditorActions(): readonly IMonacoEditorAction[]
}

export interface CoreCommand {
  id: string
  /** English fallback shown when __MONACO_NLS__ has no translation. */
  label: string
  /** NLS key monaco itself uses for this command's command-palette title. */
  nlsKey: string
  /** Numeric KeyMod | KeyCode encoding, same form the decoder accepts. */
  primary: number
}

/**
 * Side-table: commandId → its first decoded default keybinding. KeybindingsEditor
 * reads from this to show the default key; FileEditor reads from this to figure
 * out which native monaco keys to swallow when the user has rebound the command.
 */
const _defaults = new Map<string, DecodedKeybinding>()

export function getMonacoDefaultKeybinding(commandId: string): DecodedKeybinding | undefined {
  return _defaults.get(commandId)
}

export function getAllMonacoDefaultKeybindings(): ReadonlyMap<string, DecodedKeybinding> {
  return _defaults
}

// Reverse view of `_defaults` in the registry key space (D7), keyed for the
// single global keydown dispatcher (D3) to consult when an editor widget has
// focus. Single-stroke defaults map key → command; chord defaults contribute
// only their first stroke to `_chordPrefixes`, so the dispatcher yields the
// whole chord to Monaco's own state machine.
const _defaultKeyToCommand = new Map<string, string>()
const _chordPrefixes = new Set<string>()

function rebuildDefaultKeyTables(): void {
  _defaultKeyToCommand.clear()
  _chordPrefixes.clear()
  for (const [commandId, decoded] of _defaults) {
    if (decoded.chords) {
      _chordPrefixes.add(decodedToRegistryKeyString({ key: decoded.chords[0] }))
    } else if (decoded.key !== undefined) {
      const key = decodedToRegistryKeyString(decoded)
      if (!_defaultKeyToCommand.has(key)) _defaultKeyToCommand.set(key, commandId)
    }
  }
}

/** Outcome of {@link monacoDeferDecision}, from the dispatcher's point of view. */
export type MonacoDeferDecision =
  /** The key is Monaco's to handle — don't preventDefault, let it bubble to Monaco. */
  | 'defer'
  /** The user rebound this Monaco command; swallow Monaco's original default key. */
  | 'swallow'
  /** Not a Monaco default — the project dispatcher owns it. */
  | 'proceed'

/**
 * Decide who should handle `registryKey` while an editor widget holds focus.
 * The dispatcher passes `isCommandRebound` (true when the user moved a command
 * to a different key) so a rebound Monaco default is swallowed rather than
 * fired twice.
 */
export function monacoDeferDecision(
  registryKey: string,
  isCommandRebound: (commandId: string) => boolean,
): MonacoDeferDecision {
  if (_chordPrefixes.has(registryKey)) return 'defer'
  const commandId = _defaultKeyToCommand.get(registryKey)
  if (commandId === undefined) return 'proceed'
  return isCommandRebound(commandId) ? 'swallow' : 'defer'
}

function nlsLookup(key: string, fallback: string): string {
  const table = (globalThis as { __MONACO_NLS__?: Record<string, string> }).__MONACO_NLS__
  const v = table?.[key]
  return typeof v === 'string' ? v : fallback
}

function makeHandler(commandId: string) {
  return (accessor: ServicesAccessor, ...args: unknown[]): void => {
    const groups = accessor.get(IEditorGroupsService)
    const activeInput = groups.activeGroup.activeEditor
    const editor =
      activeInput instanceof FileEditorInput ? FileEditorRegistry.get(activeInput) : undefined
    if (!editor) {
      // The mirrored editor.action.* commands are always listed in the command
      // palette (CommandsQuickAccessProvider enumerates CommandsRegistry without
      // when-filtering), so a user can pick one with no active text editor. Tell
      // them why nothing happened instead of returning silently.
      accessor.get(INotificationService).status('该命令需要一个活动的文本编辑器')
      return
    }
    editor.trigger('', commandId, args[0] ?? {})
  }
}

function firstPrimaryOf(kbOpts: IMonacoEditorAction['_kbOpts']): number | undefined {
  if (!kbOpts) return undefined
  const arr = Array.isArray(kbOpts) ? kbOpts : [kbOpts]
  for (const opt of arr) {
    if (opt.primary && opt.primary !== 0) return opt.primary
  }
  return undefined
}

// Core editor commands Monaco registers outside the EditorAction registry, so
// the loop above never sees them. Mirror them by hand so undo/redo/select-all
// show up in our CommandsRegistry (Edit menu, Keyboard Shortcuts editor). Their
// default keys go into the side-table only, leaving Monaco's own dispatch in
// charge of the actual key handling.
const ctrl = (token: string): number => MASK_CTRLCMD | TOKEN_TO_KEYCODE[token]!

const CORE_COMMANDS: readonly CoreCommand[] = [
  { id: 'undo', label: 'Undo', nlsKey: 'undo', primary: ctrl('z') },
  { id: 'redo', label: 'Redo', nlsKey: 'redo', primary: ctrl('y') },
  {
    id: 'editor.action.selectAll',
    label: 'Select All',
    nlsKey: 'editor.action.selectAll',
    primary: ctrl('a'),
  },
]

/**
 * Main entrypoint. Calls into monaco's internal modules — must run AFTER
 * `import('monaco-editor')` has resolved.
 */
export async function bridgeAllMonacoActions(): Promise<IDisposable> {
  const mod = (await import('monaco-editor/esm/vs/editor/browser/editorExtensions.js')) as {
    EditorExtensionsRegistry: IMonacoEditorExtensionsRegistry
  }
  return markAsSingleton(bridgeMonacoActionsForTests(mod.EditorExtensionsRegistry, CORE_COMMANDS))
}

/**
 * Test seam. Tests supply a fake registry; we never touch real monaco here.
 */
export function bridgeMonacoActionsForTests(
  registry: IMonacoEditorExtensionsRegistry,
  coreCommands: readonly CoreCommand[],
): IDisposable {
  const disposables: IDisposable[] = []
  const seenIds = new Set<string>()
  const installedDefaults: string[] = []

  for (const action of registry.getEditorActions()) {
    if (seenIds.has(action.id)) continue
    seenIds.add(action.id)

    disposables.push(
      CommandsRegistry.registerCommand({
        id: action.id,
        metadata: { description: action.label, category: 'Editor' },
        handler: makeHandler(action.id),
      }),
    )

    const primary = firstPrimaryOf(action._kbOpts)
    if (primary !== undefined) {
      const decoded = decodeMonacoKeybinding(primary)
      if (decoded && !_defaults.has(action.id)) {
        _defaults.set(action.id, decoded)
        installedDefaults.push(action.id)
      }
    }
  }

  for (const core of coreCommands) {
    if (seenIds.has(core.id)) continue
    seenIds.add(core.id)
    const label = nlsLookup(core.nlsKey, core.label)
    disposables.push(
      CommandsRegistry.registerCommand({
        id: core.id,
        metadata: { description: label, category: 'Editor' },
        handler: makeHandler(core.id),
      }),
    )
    const decoded = decodeMonacoKeybinding(core.primary)
    if (decoded && !_defaults.has(core.id)) {
      _defaults.set(core.id, decoded)
      installedDefaults.push(core.id)
    }
  }

  disposables.push({
    dispose() {
      for (const id of installedDefaults) _defaults.delete(id)
      rebuildDefaultKeyTables()
    },
  })
  rebuildDefaultKeyTables()
  return combinedDisposable(...disposables)
}
