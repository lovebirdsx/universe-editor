/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoActionsBridge — at MonacoLoader bootstrap time, enumerate every
 *  EditorAction registered with monaco's internal EditorContributionRegistry
 *  (find, replace, formatDocument, rename, …), plus a small hand-listed set
 *  of core editor commands (undo / redo / selectAll) that monaco registers
 *  outside that registry, and mirror them into our own CommandsRegistry so
 *  the Keyboard Shortcuts editor can list and rebind them.
 *
 *  Each action's *default* keybindings are also registered into our
 *  KeybindingsRegistry at the lowest priority tier ({@link
 *  KeybindingWeight.MonacoDefault}) with a `when: editorFocus` clause. This
 *  makes the registry the single arbiter for every keystroke: any project /
 *  extension / user binding outranks a Monaco default on the same key, while a
 *  Monaco default that wins unopposed is *deferred* by the dispatcher — it does
 *  not preventDefault, so the event reaches Monaco's own context-aware dispatch
 *  (ESC in a find widget still cancels it, IntelliSense ESC still dismisses,
 *  Ctrl+K chords still work) which re-evaluates the key with its real internal
 *  when-clauses. A user override is just a higher-weight binding; disabling a
 *  default (`-command`) is a negation entry that suppresses the MonacoDefault
 *  binding via the registry's removal semantics.
 *
 *  The first decoded default per command is also kept in a `_defaults`
 *  side-table read by the Keyboard Shortcuts editor to show the built-in key.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  IEditorGroupsService,
  INotificationService,
  KeybindingsRegistry,
  KeybindingWeight,
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
 * Side-table: commandId → its first decoded default keybinding. The Keyboard
 * Shortcuts editor reads from this to show the built-in key when neither the
 * registry nor a user override supplies one.
 */
const _defaults = new Map<string, DecodedKeybinding>()

export function getMonacoDefaultKeybinding(commandId: string): DecodedKeybinding | undefined {
  return _defaults.get(commandId)
}

export function getAllMonacoDefaultKeybindings(): ReadonlyMap<string, DecodedKeybinding> {
  return _defaults
}

/** Convert one decoded chord stroke into the registry key-space string. */
function strokeToRegistryKey(stroke: string): string {
  return decodedToRegistryKeyString({ key: stroke })
}

/**
 * Register one Monaco default keybinding into KeybindingsRegistry at the
 * MonacoDefault tier, gated on `editorFocus` so it only competes while an
 * editor widget holds focus.
 */
function registerMonacoDefault(commandId: string, decoded: DecodedKeybinding): IDisposable {
  if (decoded.chords) {
    const chords: readonly [string, string] = [
      strokeToRegistryKey(decoded.chords[0]),
      strokeToRegistryKey(decoded.chords[1]),
    ]
    return KeybindingsRegistry.registerKeybinding({
      chords,
      command: commandId,
      when: 'editorFocus',
      weight: KeybindingWeight.MonacoDefault,
    })
  }
  return KeybindingsRegistry.registerKeybinding({
    key: strokeToRegistryKey(decoded.key!),
    command: commandId,
    when: 'editorFocus',
    weight: KeybindingWeight.MonacoDefault,
  })
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

/** Every distinct, non-empty `primary` across an action's `_kbOpts`. */
function allPrimariesOf(kbOpts: IMonacoEditorAction['_kbOpts']): number[] {
  if (!kbOpts) return []
  const arr = Array.isArray(kbOpts) ? kbOpts : [kbOpts]
  const out: number[] = []
  for (const opt of arr) {
    if (opt.primary && opt.primary !== 0 && !out.includes(opt.primary)) out.push(opt.primary)
  }
  return out
}

// Core editor commands Monaco registers outside the EditorAction registry, so
// the loop above never sees them. Mirror them by hand so undo/redo/select-all
// show up in our CommandsRegistry (Edit menu, Keyboard Shortcuts editor) and
// their default keys participate in registry arbitration like every other
// Monaco default.
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

  const recordDefaults = (commandId: string, primaries: readonly number[]): void => {
    for (const primary of primaries) {
      const decoded = decodeMonacoKeybinding(primary)
      if (!decoded) continue
      disposables.push(registerMonacoDefault(commandId, decoded))
      if (!_defaults.has(commandId)) {
        _defaults.set(commandId, decoded)
        installedDefaults.push(commandId)
      }
    }
  }

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

    recordDefaults(action.id, allPrimariesOf(action._kbOpts))
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
    recordDefaults(core.id, [core.primary])
  }

  disposables.push({
    dispose() {
      for (const id of installedDefaults) _defaults.delete(id)
    },
  })
  return combinedDisposable(...disposables)
}
