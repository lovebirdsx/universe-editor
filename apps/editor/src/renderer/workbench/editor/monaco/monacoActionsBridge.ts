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
  combinedDisposable,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../FileEditorInput.js'
import { FileEditorRegistry } from '../FileEditorRegistry.js'
import { decodeMonacoKeybinding, type DecodedKeybinding } from './monacoKeybindingDecoder.js'

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

const CtrlCmd = 2048
const KC_KeyA = 31
const KC_KeyY = 55
const KC_KeyZ = 56

const DEFAULT_CORE_COMMANDS: readonly CoreCommand[] = [
  { id: 'undo', label: 'Undo', nlsKey: 'undo', primary: CtrlCmd | KC_KeyZ },
  { id: 'redo', label: 'Redo', nlsKey: 'redo', primary: CtrlCmd | KC_KeyY },
  {
    id: 'editor.action.selectAll',
    label: 'Select All',
    nlsKey: 'selectAll.label',
    primary: CtrlCmd | KC_KeyA,
  },
]

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

function nlsLookup(key: string, fallback: string): string {
  const table = (globalThis as { __MONACO_NLS__?: Record<string, string> }).__MONACO_NLS__
  const v = table?.[key]
  return typeof v === 'string' ? v : fallback
}

function makeHandler(commandId: string) {
  return (accessor: ServicesAccessor): void => {
    const groups = accessor.get(IEditorGroupsService)
    const activeInput = groups.activeGroup.activeEditor
    if (!(activeInput instanceof FileEditorInput)) return
    FileEditorRegistry.get(activeInput)?.trigger('', commandId, {})
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

/**
 * Main entrypoint. Calls into monaco's internal modules — must run AFTER
 * `import('monaco-editor')` has resolved.
 */
export async function bridgeAllMonacoActions(): Promise<IDisposable> {
  const mod = (await import('monaco-editor/esm/vs/editor/browser/editorExtensions.js')) as {
    EditorExtensionsRegistry: IMonacoEditorExtensionsRegistry
  }
  return bridgeMonacoActionsForTests(mod.EditorExtensionsRegistry, DEFAULT_CORE_COMMANDS)
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
    },
  })
  return combinedDisposable(...disposables)
}
