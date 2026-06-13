/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File-backed user keybinding overrides. Reads keybindings.json on startup
 *  and on every external edit, applies entries to KeybindingsRegistry, and
 *  persists changes back when setKeybinding()/resetKeybinding() are called.
 *
 *  File format mirrors VSCode:
 *    [
 *      { "key": "ctrl+shift+b", "command": "workbench.action.foo", "when": "..." },
 *      { "key": "ctrl+k", "command": "-workbench.action.bar" }   // "-" = disable default
 *    ]
 *--------------------------------------------------------------------------------------------*/

import { parse, type ParseError } from 'jsonc-parser'
import {
  CommandsRegistry,
  createDecorator,
  Disposable,
  DisposableStore,
  Emitter,
  type Event,
  InstantiationType,
  IStorageService,
  IUserDataFilesService,
  KeybindingsRegistry,
  KeybindingWeight,
  normalizeKeybindingString,
  type IKeybindingItem,
  registerSingleton,
  URI,
  UserDataFile,
} from '@universe-editor/platform'
import { formatKey, formatChord } from '../../workbench/titlebar/keybindingFormat.js'

export interface IUserKeybindingEntry {
  command: string
  /**
   * Key for this entry, in the registry key space ('ctrl+shift+b', or a
   * space-joined 2-stroke chord 'ctrl+k ctrl+s').
   *  - positive entry (`isRemoval` falsy): the key the command is bound to.
   *  - removal entry (`isRemoval` true): the specific key to disable, or `null`
   *    to disable every binding of the command.
   */
  key: string | null
  /** True for a `-command` disable entry; false/undefined for a normal binding. */
  isRemoval?: boolean
  when?: string
  /** Forwarded to the command when the binding fires (VSCode-style `args`). */
  args?: unknown
}

/** A disabled (command, key) pair surfaced for Monaco-side default unbinding. */
export interface IDisabledBinding {
  command: string
  /** Specific disabled key (registry key space), or null = whole command. */
  key: string | null
}

interface FileKeybindingEntry {
  key?: string
  command: string
  when?: string
  args?: unknown
}

export interface IUserKeybindingsService {
  readonly _serviceBrand: undefined
  readonly onDidChange: Event<void>
  readonly userEntries: readonly IUserKeybindingEntry[]
  /** Commands fully disabled via a keyless `-command` entry in either layer (deduped). */
  readonly disabledCommands: readonly string[]
  /** Every `-command` disable across both layers, keyed (command, key) for Monaco-side sync. */
  readonly disabledBindings: readonly IDisabledBinding[]
  /** Synchronous snapshot of the last VSCode-layer reload, for keyboard-debug diagnostics. */
  readonly diagnostics: IUserKeybindingsDiagnostics
  initialize(): Promise<void>
  reload(): Promise<void>
  setKeybinding(command: string, key: string | null, when?: string): void
  resetKeybinding(command: string): void
  getUserEntry(command: string): IUserKeybindingEntry | undefined
  getDefaultKey(command: string): string | undefined
}

export interface IUserKeybindingsDiagnostics {
  /** Resolved fs path of the read-only VSCode keybindings layer (best-effort). */
  vscodeFilePath: string | undefined
  /** Entries parsed out of the VSCode keybindings file on the last reload. */
  vscodeParsedCount: number
  /** Of those, how many actually registered (the rest were dropped by the command-existence filter). */
  vscodeRegisteredCount: number
}

export const IUserKeybindingsService =
  createDecorator<IUserKeybindingsService>('userKeybindingsService')

const LEGACY_STORAGE_KEY = 'workbench.userKeybindings'

function keyToKeybindingItem(entry: IUserKeybindingEntry): IKeybindingItem | undefined {
  if (entry.key === null) return undefined

  const strokes = entry.key.trim().split(/\s+/)
  const base = {
    command: entry.command,
    weight: KeybindingWeight.User,
    ...(entry.when !== undefined ? { when: entry.when } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
  }

  if (strokes.length === 2) {
    return { ...base, chords: [strokes[0]!, strokes[1]!] as [string, string] }
  }
  if (strokes.length === 1 && strokes[0] !== '') {
    return { ...base, key: strokes[0]! }
  }
  return undefined
}

function entryToFile(entry: IUserKeybindingEntry): FileKeybindingEntry {
  if (entry.isRemoval) {
    return {
      command: '-' + entry.command,
      // A removal may target one specific key (key !== null) or the whole
      // command (key === null). Preserve the key so the disable stays precise.
      ...(entry.key !== null ? { key: entry.key } : {}),
      ...(entry.when !== undefined ? { when: entry.when } : {}),
    }
  }
  return {
    key: entry.key!,
    command: entry.command,
    ...(entry.when !== undefined ? { when: entry.when } : {}),
    ...(entry.args !== undefined ? { args: entry.args } : {}),
  }
}

function fileToEntry(raw: FileKeybindingEntry): IUserKeybindingEntry | null {
  if (typeof raw.command !== 'string' || raw.command.length === 0) return null
  if (raw.command.startsWith('-')) {
    const cmd = raw.command.slice(1)
    if (cmd.length === 0) return null
    // Preserve the key on a `-command` removal: with a key it disables only that
    // binding (VSCode `{key, command:"-x"}`), without one it disables the whole
    // command. Dropping the key here was the bug that turned a single-key
    // disable into a whole-command unbind (Bug 2: F3 disable killed Enter too).
    return {
      command: cmd,
      key: typeof raw.key === 'string' && raw.key.length > 0 ? raw.key : null,
      isRemoval: true,
      ...(typeof raw.when === 'string' ? { when: raw.when } : {}),
    }
  }
  if (typeof raw.key !== 'string' || raw.key.length === 0) return null
  return {
    command: raw.command,
    key: raw.key,
    ...(typeof raw.when === 'string' ? { when: raw.when } : {}),
    ...(raw.args !== undefined ? { args: raw.args } : {}),
  }
}

function parseKeybindingsFile(text: string): IUserKeybindingEntry[] {
  if (text.trim() === '') return []
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !Array.isArray(parsed)) return []
  const result: IUserKeybindingEntry[] = []
  for (const raw of parsed) {
    if (raw && typeof raw === 'object') {
      const entry = fileToEntry(raw as FileKeybindingEntry)
      if (entry) result.push(entry)
    }
  }
  return result
}

export class UserKeybindingsService extends Disposable implements IUserKeybindingsService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  // Flat list of user-layer (keybindings.json) entries. A single command may
  // contribute several entries — e.g. a positive rebind plus an auto-appended
  // removal of its original default key — so this is a list, not a per-command
  // map. The whole user layer is re-registered wholesale on any change.
  private readonly _userEntries: IUserKeybindingEntry[] = []
  private readonly _registrationStore = this._register(new DisposableStore())
  private readonly _vscodeRegistrationStore = this._register(new DisposableStore())
  private readonly _defaultSnapshot = new Map<string, string>()

  /** `-command` disables from the read-only VSCode layer, last reload (key may be null = whole command). */
  private readonly _vscodeDisabled: IDisabledBinding[] = []

  /** Suspend file write-back while we apply an external file change. */
  private _suspendWriteBack = false

  /** Serializes reload() calls so concurrent callers (ExtensionsContribution +
   *  the monaco action bridge) never interleave store clears/re-registrations. */
  private _reloadChain: Promise<void> = Promise.resolve()

  private readonly _diagnostics: IUserKeybindingsDiagnostics = {
    vscodeFilePath: undefined,
    vscodeParsedCount: 0,
    vscodeRegisteredCount: 0,
  }

  get diagnostics(): IUserKeybindingsDiagnostics {
    return this._diagnostics
  }

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IUserDataFilesService private readonly _files: IUserDataFilesService,
  ) {
    super()
    // Snapshot defaults now — all registerAction2() calls have already run
    // synchronously when their modules were imported, which happens before
    // bootstrapWorkbench() runs.
    this._takeDefaultSnapshot()
    void this._files.getFileUri(UserDataFile.VSCodeKeybindings).then((uri) => {
      const revived = uri ? URI.revive(uri) : undefined
      if (revived) this._diagnostics.vscodeFilePath = revived.fsPath
    })
  }

  private _takeDefaultSnapshot(): void {
    const all = KeybindingsRegistry.getAllKeybindings()
    // Iterate newest-first (LIFO) so we record the effective default for each command.
    for (let i = all.length - 1; i >= 0; i--) {
      const kb = all[i]
      if (!kb || kb.isNegated || this._defaultSnapshot.has(kb.command)) continue
      if (kb.chords) {
        this._defaultSnapshot.set(kb.command, formatChord(kb.chords))
      } else if (kb.key !== undefined) {
        this._defaultSnapshot.set(kb.command, formatKey(kb.key))
      }
    }
  }

  async initialize(): Promise<void> {
    await this._migrateLegacyKeybindings()
    await this._reloadVSCodeFile()
    await this._reloadFromFile()

    this._register(
      this._files.onDidChangeFile((file) => {
        if (file === UserDataFile.VSCodeKeybindings) {
          void this._reloadVSCodeAndUser()
        } else if (file === UserDataFile.Keybindings) {
          void this._reloadFromFile()
        }
      }),
    )
  }

  get userEntries(): readonly IUserKeybindingEntry[] {
    return [...this._userEntries]
  }

  get disabledCommands(): readonly string[] {
    const set = new Set<string>()
    // Only keyless removals disable a whole command; a keyed removal frees just
    // one key and leaves the command's other bindings live.
    for (const d of this._vscodeDisabled) if (d.key === null) set.add(d.command)
    for (const entry of this._userEntries) {
      if (entry.isRemoval && entry.key === null) set.add(entry.command)
    }
    return [...set]
  }

  get disabledBindings(): readonly IDisabledBinding[] {
    const out: IDisabledBinding[] = [...this._vscodeDisabled]
    for (const entry of this._userEntries) {
      if (entry.isRemoval) out.push({ command: entry.command, key: entry.key })
    }
    return out
  }

  // Re-evaluate VSCode + user bindings. Extension-contributed commands register
  // into CommandsRegistry asynchronously (after the extension host boots), long
  // after initialize() ran at startup — so VSCode bindings to those commands were
  // skipped by the command-existence filter in _reloadVSCodeFile(). Callers invoke
  // this once extension commands are present to pick those bindings back up.
  async reload(): Promise<void> {
    this._reloadChain = this._reloadChain.then(
      () => this._reloadVSCodeAndUser(),
      () => this._reloadVSCodeAndUser(),
    )
    return this._reloadChain
  }

  getUserEntry(command: string): IUserKeybindingEntry | undefined {
    // Prefer the positive (rebind) entry so the shortcuts editor shows the new
    // key; fall back to a removal entry so a pure disable still reads as "User".
    return (
      this._userEntries.find((e) => e.command === command && !e.isRemoval) ??
      this._userEntries.find((e) => e.command === command)
    )
  }

  getDefaultKey(command: string): string | undefined {
    return this._defaultSnapshot.get(command)
  }

  setKeybinding(command: string, key: string | null, when?: string): void {
    // Replace any prior user-layer entries for this command (positive + the
    // removals we previously auto-appended).
    this._removeUserEntries(command)

    if (key === null) {
      // Pure disable: a keyless removal that frees the command entirely.
      this._userEntries.push({ command, key: null, isRemoval: true })
    } else {
      this._userEntries.push({
        command,
        key,
        ...(when !== undefined ? { when } : {}),
      })
      // Mirror VSCode's rebind UX: appending a removal of each original default
      // key so the old key stops firing the command once it's been moved. This
      // replaces the deleted dispatcher-side 'swallow' mechanism.
      for (const defaultKey of this._defaultKeysOf(command)) {
        if (defaultKey === normalizeKeybindingString(key)) continue
        this._userEntries.push({ command, key: defaultKey, isRemoval: true })
      }
    }

    this._applyAllUserEntries()
    void this._writeFile()
    this._onDidChange.fire()
  }

  resetKeybinding(command: string): void {
    this._removeUserEntries(command)
    this._applyAllUserEntries()
    void this._writeFile()
    this._onDidChange.fire()
  }

  private _removeUserEntries(command: string): void {
    for (let i = this._userEntries.length - 1; i >= 0; i--) {
      if (this._userEntries[i]!.command === command) this._userEntries.splice(i, 1)
    }
  }

  /**
   * Registry key-space strings of every active default binding for `command` —
   * non-negated bindings below User weight (project Action2s and mirrored Monaco
   * defaults). Used to auto-negate the original key on rebind.
   */
  private _defaultKeysOf(command: string): string[] {
    const out: string[] = []
    for (const kb of KeybindingsRegistry.getAllKeybindings()) {
      if (kb.command !== command || kb.isNegated) continue
      if ((kb.weight ?? KeybindingWeight.WorkbenchContrib) >= KeybindingWeight.User) continue
      const key = kb.chords ? `${kb.chords[0]} ${kb.chords[1]}` : kb.key
      if (key !== undefined && !out.includes(key)) out.push(key)
    }
    return out
  }

  private async _reloadVSCodeFile(): Promise<void> {
    const text = await this._files.read(UserDataFile.VSCodeKeybindings)
    const entries = parseKeybindingsFile(text)
    this._vscodeRegistrationStore.clear()
    this._vscodeDisabled.length = 0
    let registered = 0
    for (const entry of entries) {
      if (entry.isRemoval) this._vscodeDisabled.push({ command: entry.command, key: entry.key })
      if (!CommandsRegistry.getCommand(entry.command)) continue
      // No per-command dedup here: a single command may legitimately have several
      // VSCode bindings (e.g. the user's custom key plus the kept default). The
      // store is cleared wholesale each reload, so every entry registers fresh.
      this._registerEntry(entry, this._vscodeRegistrationStore)
      registered++
    }
    this._diagnostics.vscodeParsedCount = entries.length
    this._diagnostics.vscodeRegisteredCount = registered
  }

  private async _reloadVSCodeAndUser(): Promise<void> {
    // Clear user entries first so they can be re-registered after VSCode entries (LIFO order).
    this._registrationStore.clear()
    await this._reloadVSCodeFile()
    await this._reloadFromFile()
  }

  private async _reloadFromFile(): Promise<void> {
    if (this._suspendWriteBack) return
    const text = await this._files.read(UserDataFile.Keybindings)
    const entries = parseKeybindingsFile(text)
    this._suspendWriteBack = true
    try {
      this._userEntries.length = 0
      this._userEntries.push(...entries)
      this._applyAllUserEntries()
    } finally {
      this._suspendWriteBack = false
    }
    this._onDidChange.fire()
  }

  // Re-register the entire user layer from `_userEntries`. The whole layer is
  // rebuilt on any change (the file is the source of truth), so there's no
  // incremental per-command bookkeeping.
  private _applyAllUserEntries(): void {
    this._registrationStore.clear()
    for (const entry of this._userEntries) this._registerEntry(entry, this._registrationStore)
  }

  // Registers a single entry into `store`. Positive entries add a binding;
  // removal entries add negation(s) that suppress matching bindings via the
  // registry's removal semantics.
  private _registerEntry(entry: IUserKeybindingEntry, store: DisposableStore): void {
    if (entry.isRemoval) {
      if (entry.key === null) {
        // Whole-command disable: negate every current non-negated binding.
        for (const kb of KeybindingsRegistry.getAllKeybindings()) {
          if (kb.command !== entry.command || kb.isNegated) continue
          if (kb.chords) {
            store.add(
              KeybindingsRegistry.registerKeybinding({
                chords: kb.chords as [string, string],
                command: entry.command,
                isNegated: true,
              }),
            )
          } else if (kb.key !== undefined) {
            store.add(
              KeybindingsRegistry.registerKeybinding({
                key: kb.key,
                command: entry.command,
                isNegated: true,
              }),
            )
          }
        }
        return
      }
      // Keyed disable: negate just (command, key), leaving siblings live.
      const strokes = entry.key.trim().split(/\s+/)
      const negation: IKeybindingItem =
        strokes.length === 2
          ? {
              chords: [strokes[0]!, strokes[1]!] as [string, string],
              command: entry.command,
              isNegated: true,
            }
          : { key: strokes[0]!, command: entry.command, isNegated: true }
      store.add(KeybindingsRegistry.registerKeybinding(negation))
      return
    }

    const item = keyToKeybindingItem(entry)
    if (!item) return
    store.add(KeybindingsRegistry.registerKeybinding(item))
  }

  private async _writeFile(): Promise<void> {
    const fileEntries = this._userEntries.map(entryToFile)
    const body = `// User keybinding overrides — edit and save to apply immediately.\n${JSON.stringify(fileEntries, null, 2)}\n`
    await this._files.write(UserDataFile.Keybindings, body)
  }

  private async _migrateLegacyKeybindings(): Promise<void> {
    const existing = await this._files.read(UserDataFile.Keybindings)
    if (existing.trim() !== '') return
    const legacy = await this._storage.get<IUserKeybindingEntry[]>(LEGACY_STORAGE_KEY)
    if (!Array.isArray(legacy) || legacy.length === 0) return
    const fileEntries = legacy.map(entryToFile)
    const body = `// User keybindings — migrated from previous storage on first launch.\n${JSON.stringify(fileEntries, null, 2)}\n`
    await this._files.write(UserDataFile.Keybindings, body)
    await this._storage.set(LEGACY_STORAGE_KEY, [])
  }
}

registerSingleton(IUserKeybindingsService, UserKeybindingsService, InstantiationType.Delayed)
