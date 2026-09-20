/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoActionsBridge — at MonacoLoader bootstrap time, enumerate every
 *  EditorAction registered with monaco's internal EditorContributionRegistry
 *  (find, replace, formatDocument, rename, …), plus a hand-listed set
 *  of core editor commands (undo / redo / selectAll / cursorColumnSelect*)
 *  that monaco registers
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
 *
 *  Platform overrides are resolved the way monaco resolves them: a `win` / `mac`
 *  / `linux` block replaces the whole rule (base `primary`/`secondary` dropped),
 *  and `primary: 0` means "no key on this platform". Mirroring the base rule
 *  instead used to leave phantom rows in the registry — on Linux `Alt+Shift+↓`
 *  showed up as copy-line while monaco actually ran add-cursor-below, and
 *  `Ctrl+PageUp` showed up as scroll-page while monaco binds `Alt+PageUp` there.
 *  Only `primary` is mirrored, never `secondary`: adding those would put a
 *  second MonacoDefault row on 30+ commands for no arbitration benefit.
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  IEditorGroupsService,
  INotificationService,
  KeybindingsRegistry,
  KeybindingWeight,
  combinedDisposable,
  localize,
  markAsSingleton,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorRegistry } from '../../../services/editor/FileEditorRegistry.js'
import {
  MONACO_COMPAT_KEYBINDINGS,
  registerMonacoCompatKeybindings,
  type IMonacoCompatKeybinding,
} from './monacoCompatKeybindings.js'
import {
  decodeMonacoKeybinding,
  decodedToRegistryKeyString,
  MASK_CTRLCMD,
  TOKEN_TO_KEYCODE,
  type DecodedKeybinding,
} from './monacoKeybindingDecoder.js'

/** The three platforms monaco's `bindToCurrentPlatform` distinguishes. */
export type MonacoPlatform = 'win32' | 'darwin' | 'linux'

/** One platform's override block. Replaces the whole rule, it does not merge. */
export interface IMonacoPlatformRule {
  readonly primary?: number
  /** Read into the type for fidelity; deliberately not mirrored (see header). */
  readonly secondary?: readonly number[]
}

export interface IMonacoKbRule extends IMonacoPlatformRule {
  readonly win?: IMonacoPlatformRule
  readonly mac?: IMonacoPlatformRule
  readonly linux?: IMonacoPlatformRule
}

/** `_kbOpts` as monaco's Command constructor sets it. */
export interface IMonacoKbOpts extends IMonacoKbRule {
  readonly kbExpr?: unknown
  readonly weight?: number
  readonly args?: unknown
}

interface IMonacoEditorAction {
  readonly id: string
  readonly label: string
  // `_kbOpts` is the private field set by Command#constructor.
  readonly _kbOpts?: IMonacoKbOpts | readonly IMonacoKbOpts[]
}

export interface IMonacoEditorExtensionsRegistry {
  getEditorActions(): readonly IMonacoEditorAction[]
}

export interface CoreCommandKeybinding extends IMonacoKbRule {
  /** Numeric KeyMod | KeyCode encoding, same form the decoder accepts. */
  primary: number
  /** Registry when-clause. Defaults to `editorFocus`, matching mirrored EditorActions. */
  when?: string
}

export interface CoreCommand {
  id: string
  /** English fallback shown when no translation is found. */
  label: string
  /**
   * Key into the `__MONACO_NLS__` table (keyed by English source text, see
   * monacoNlsBootstrap) for this command's command-palette title.
   */
  nlsKey?: string
  /**
   * Our own NLS key, resolved via `localize` when the command is absent from
   * the monaco translation table.
   */
  labelKey?: string
  /** Back-compat shorthand for a single default keybinding. */
  primary?: number
  /** Default keybindings to mirror into the registry. */
  keybindings?: readonly CoreCommandKeybinding[]
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
function registerMonacoDefault(
  commandId: string,
  decoded: DecodedKeybinding,
  when = 'editorFocus',
): IDisposable {
  if (decoded.chords) {
    const chords: readonly [string, string] = [
      strokeToRegistryKey(decoded.chords[0]),
      strokeToRegistryKey(decoded.chords[1]),
    ]
    return KeybindingsRegistry.registerKeybinding({
      chords,
      command: commandId,
      when,
      weight: KeybindingWeight.MonacoDefault,
    })
  }
  return KeybindingsRegistry.registerKeybinding({
    key: strokeToRegistryKey(decoded.key!),
    command: commandId,
    when,
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
    // Capability-based, not instanceof FileEditorInput: untitled buffers (and any
    // other text input mounted through FileEditor) register here too, and Monaco
    // actions like multicursor / find must work on them.
    const editor = activeInput ? FileEditorRegistry.get(activeInput) : undefined
    if (!editor) {
      // The mirrored editor.action.* commands are always listed in the command
      // palette (CommandsQuickAccessProvider enumerates CommandsRegistry without
      // when-filtering), so a user can pick one with no active text editor. Tell
      // them why nothing happened instead of returning silently.
      accessor
        .get(INotificationService)
        .status(localize('monaco.needsActiveEditor', 'This command requires an active text editor'))
      return
    }
    editor.trigger('', commandId, args[0] ?? {})
  }
}

const PLATFORM_RULE_KEY = { win32: 'win', darwin: 'mac', linux: 'linux' } as const

/**
 * Replicates monaco's `bindToCurrentPlatform`: an override block replaces the
 * whole rule, so the base `primary` is gone on that platform — it is not merged
 * and not kept as a fallback.
 */
export function resolvePlatformRule(
  rule: IMonacoKbRule,
  platform: MonacoPlatform,
): IMonacoPlatformRule {
  return rule[PLATFORM_RULE_KEY[platform]] ?? rule
}

function isRuleArray(
  kbOpts: IMonacoKbOpts | readonly IMonacoKbOpts[],
): kbOpts is readonly IMonacoKbOpts[] {
  return Array.isArray(kbOpts)
}

/**
 * Every distinct non-zero `primary` an action contributes on `platform`.
 * `primary: 0` yields nothing: monaco means "no key here", and the registry
 * expresses absence by having no item — a negation entry would show up as a
 * user-made unbind in the Keyboard Shortcuts editor.
 */
export function effectivePrimariesOf(
  kbOpts: IMonacoKbOpts | readonly IMonacoKbOpts[] | undefined,
  platform: MonacoPlatform,
): number[] {
  if (!kbOpts) return []
  const rules = isRuleArray(kbOpts) ? kbOpts : [kbOpts]
  const out: number[] = []
  for (const rule of rules) {
    const primary = resolvePlatformRule(rule, platform).primary
    if (primary !== undefined && primary !== 0 && !out.includes(primary)) out.push(primary)
  }
  return out
}

function coreKeybindingsOf(
  core: CoreCommand,
  platform: MonacoPlatform,
): readonly CoreCommandKeybinding[] {
  const declared =
    core.keybindings ?? (typeof core.primary === 'number' ? [{ primary: core.primary }] : [])
  const out: CoreCommandKeybinding[] = []
  for (const kb of declared) {
    const primary = resolvePlatformRule(kb, platform).primary
    if (primary === undefined || primary === 0) continue
    out.push({ primary, ...(kb.when !== undefined ? { when: kb.when } : {}) })
  }
  return out
}

// Core editor commands Monaco registers outside the EditorAction registry, so
// the loop above never sees them. Mirror them by hand so undo/redo/select-all
// and cursor column selection show up in our CommandsRegistry (Edit menu,
// Keyboard Shortcuts editor) and their default keys participate in registry
// arbitration like every other Monaco default.
const ctrl = (token: string): number => MASK_CTRLCMD | TOKEN_TO_KEYCODE[token]!
const KEYMOD_SHIFT = 0x0400
const KEYMOD_ALT = 0x0200
const shift = (token: string): number => KEYMOD_SHIFT | TOKEN_TO_KEYCODE[token]!
const alt = (token: string): number => KEYMOD_ALT | TOKEN_TO_KEYCODE[token]!
const ctrlAltShift = (token: string): number =>
  MASK_CTRLCMD | KEYMOD_ALT | KEYMOD_SHIFT | TOKEN_TO_KEYCODE[token]!

/** Exported so a unit test can pin the shipped table rather than a copy of it. */
export const CORE_COMMANDS: readonly CoreCommand[] = [
  { id: 'undo', label: 'Undo', nlsKey: 'Undo', primary: ctrl('z') },
  { id: 'redo', label: 'Redo', nlsKey: 'Redo', primary: ctrl('y') },
  {
    id: 'editor.action.selectAll',
    label: 'Select All',
    nlsKey: 'Select All',
    primary: ctrl('a'),
  },
  {
    id: 'cursorColumnSelectUp',
    label: 'Column Select Up',
    labelKey: 'monaco.command.columnSelectUp',
    keybindings: [
      // coreCommands.js:383 — `linux: { primary: 0 }` there, so linux only keeps
      // the column-selection-mode entry below.
      { primary: ctrlAltShift('arrowup'), when: 'editorTextFocus', linux: { primary: 0 } },
      { primary: shift('arrowup'), when: 'editorTextFocus && editorColumnSelection' },
    ],
  },
  {
    id: 'cursorColumnSelectDown',
    label: 'Column Select Down',
    labelKey: 'monaco.command.columnSelectDown',
    keybindings: [
      { primary: ctrlAltShift('arrowdown'), when: 'editorTextFocus', linux: { primary: 0 } },
      { primary: shift('arrowdown'), when: 'editorTextFocus && editorColumnSelection' },
    ],
  },
  {
    // coreCommands.js:1135 — base is Cmd+PageUp, Windows and Linux move it to
    // Alt+PageUp. No `nlsKey`: monaco has no NLS entry for these two.
    id: 'scrollPageUp',
    label: 'Scroll Page Up',
    labelKey: 'monaco.command.scrollPageUp',
    keybindings: [
      {
        primary: ctrl('pageup'),
        win: { primary: alt('pageup') },
        linux: { primary: alt('pageup') },
      },
    ],
  },
  {
    id: 'scrollPageDown',
    label: 'Scroll Page Down',
    labelKey: 'monaco.command.scrollPageDown',
    keybindings: [
      {
        primary: ctrl('pagedown'),
        win: { primary: alt('pagedown') },
        linux: { primary: alt('pagedown') },
      },
    ],
  },
]

/** `OperatingSystem` values from vs/base/common/platform.js. */
const PLATFORM_BY_OS: Readonly<Record<number, MonacoPlatform>> = {
  1: 'win32',
  2: 'darwin',
  3: 'linux',
}

/**
 * Main entrypoint. Calls into monaco's internal modules — must run AFTER
 * `import('monaco-editor')` has resolved.
 */
export async function bridgeAllMonacoActions(): Promise<IDisposable> {
  const [mod, platformMod] = (await Promise.all([
    import('monaco-editor/esm/vs/editor/browser/editorExtensions.js'),
    // The very constant monaco's own bindToCurrentPlatform reads, so the mirror
    // and monaco's dispatch cannot disagree about the platform. The renderer is
    // sandboxed — `process.platform` is not available here.
    import('monaco-editor/esm/vs/base/common/platform.js'),
  ])) as [{ EditorExtensionsRegistry: IMonacoEditorExtensionsRegistry }, { OS: number }]
  const platform = PLATFORM_BY_OS[platformMod.OS] ?? 'linux'
  return markAsSingleton(
    bridgeMonacoActionsForTests(mod.EditorExtensionsRegistry, CORE_COMMANDS, platform),
  )
}

/**
 * Test seam. Tests supply a fake registry; we never touch real monaco here.
 * `platform` defaults to linux so the seam is deterministic on every host — win
 * and mac coverage has to be requested explicitly.
 */
export function bridgeMonacoActionsForTests(
  registry: IMonacoEditorExtensionsRegistry,
  coreCommands: readonly CoreCommand[],
  platform: MonacoPlatform = 'linux',
  compat: readonly IMonacoCompatKeybinding[] = MONACO_COMPAT_KEYBINDINGS,
): IDisposable {
  const disposables: IDisposable[] = []
  const seenIds = new Set<string>()
  const installedDefaults: string[] = []

  const recordDefaults = (
    commandId: string,
    keybindings: readonly CoreCommandKeybinding[],
  ): void => {
    for (const { primary, when } of keybindings) {
      const decoded = decodeMonacoKeybinding(primary)
      if (!decoded) continue
      disposables.push(registerMonacoDefault(commandId, decoded, when))
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

    recordDefaults(
      action.id,
      effectivePrimariesOf(action._kbOpts, platform).map((primary) => ({ primary })),
    )
  }

  for (const core of coreCommands) {
    if (seenIds.has(core.id)) continue
    seenIds.add(core.id)
    const fallback = core.labelKey ? localize(core.labelKey, core.label) : core.label
    const label = core.nlsKey ? nlsLookup(core.nlsKey, fallback) : fallback
    disposables.push(
      CommandsRegistry.registerCommand({
        id: core.id,
        metadata: { description: label, category: 'Editor' },
        handler: makeHandler(core.id),
      }),
    )
    recordDefaults(core.id, coreKeybindingsOf(core, platform))
  }

  // After the commands exist: an alternative key whose command is missing would
  // swallow the keystroke with nothing to run.
  disposables.push(registerMonacoCompatKeybindings(compat))

  disposables.push({
    dispose() {
      for (const id of installedDefaults) _defaults.delete(id)
    },
  })
  return combinedDisposable(...disposables)
}
