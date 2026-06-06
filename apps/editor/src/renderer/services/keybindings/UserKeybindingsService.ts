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
  combinedDisposable,
  CommandsRegistry,
  createDecorator,
  Disposable,
  DisposableStore,
  Emitter,
  type Event,
  type IDisposable,
  InstantiationType,
  IStorageService,
  IUserDataFilesService,
  KeybindingsRegistry,
  type IKeybindingItem,
  registerSingleton,
  UserDataFile,
} from '@universe-editor/platform'
import { formatKey, formatChord } from '../../workbench/titlebar/keybindingFormat.js'

export interface IUserKeybindingEntry {
  command: string
  /** Normalized key string (e.g. 'ctrl+shift+b'). null = disable default bindings. */
  key: string | null
  when?: string
}

interface FileKeybindingEntry {
  key?: string
  command: string
  when?: string
}

export interface IUserKeybindingsService {
  readonly _serviceBrand: undefined
  readonly onDidChange: Event<void>
  readonly userEntries: readonly IUserKeybindingEntry[]
  initialize(): Promise<void>
  setKeybinding(command: string, key: string | null, when?: string): void
  resetKeybinding(command: string): void
  getUserEntry(command: string): IUserKeybindingEntry | undefined
  getDefaultKey(command: string): string | undefined
}

export const IUserKeybindingsService =
  createDecorator<IUserKeybindingsService>('userKeybindingsService')

const LEGACY_STORAGE_KEY = 'workbench.userKeybindings'

function keyToKeybindingItem(entry: IUserKeybindingEntry): IKeybindingItem | undefined {
  if (entry.key === null) return undefined

  const strokes = entry.key.trim().split(/\s+/)
  const base = {
    command: entry.command,
    ...(entry.when !== undefined ? { when: entry.when } : {}),
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
  if (entry.key === null) {
    return {
      command: '-' + entry.command,
      ...(entry.when !== undefined ? { when: entry.when } : {}),
    }
  }
  return {
    key: entry.key,
    command: entry.command,
    ...(entry.when !== undefined ? { when: entry.when } : {}),
  }
}

function fileToEntry(raw: FileKeybindingEntry): IUserKeybindingEntry | null {
  if (typeof raw.command !== 'string' || raw.command.length === 0) return null
  if (raw.command.startsWith('-')) {
    const cmd = raw.command.slice(1)
    if (cmd.length === 0) return null
    return {
      command: cmd,
      key: null,
      ...(typeof raw.when === 'string' ? { when: raw.when } : {}),
    }
  }
  if (typeof raw.key !== 'string' || raw.key.length === 0) return null
  return {
    command: raw.command,
    key: raw.key,
    ...(typeof raw.when === 'string' ? { when: raw.when } : {}),
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

  private readonly _userEntries = new Map<string, IUserKeybindingEntry>()
  private readonly _registrationStore = this._register(new DisposableStore())
  private readonly _registrationDisposables = new Map<string, IDisposable>()
  private readonly _vscodeRegistrationStore = this._register(new DisposableStore())
  private readonly _vscodeRegistrationDisposables = new Map<string, IDisposable>()
  private readonly _defaultSnapshot = new Map<string, string>()

  /** Suspend file write-back while we apply an external file change. */
  private _suspendWriteBack = false

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IUserDataFilesService private readonly _files: IUserDataFilesService,
  ) {
    super()
    // Snapshot defaults now — all registerAction2() calls have already run
    // synchronously when their modules were imported, which happens before
    // bootstrapWorkbench() runs.
    this._takeDefaultSnapshot()
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
    return [...this._userEntries.values()]
  }

  getUserEntry(command: string): IUserKeybindingEntry | undefined {
    return this._userEntries.get(command)
  }

  getDefaultKey(command: string): string | undefined {
    return this._defaultSnapshot.get(command)
  }

  setKeybinding(command: string, key: string | null, when?: string): void {
    const entry: IUserKeybindingEntry = {
      command,
      key,
      ...(when !== undefined ? { when } : {}),
    }
    this._applyEntry(entry)
    void this._writeFile()
    this._onDidChange.fire()
  }

  resetKeybinding(command: string): void {
    const d = this._registrationDisposables.get(command)
    if (d) {
      this._registrationStore.delete(d)
      this._registrationDisposables.delete(command)
    }
    this._userEntries.delete(command)
    void this._writeFile()
    this._onDidChange.fire()
  }

  private async _reloadVSCodeFile(): Promise<void> {
    const text = await this._files.read(UserDataFile.VSCodeKeybindings)
    const entries = parseKeybindingsFile(text)
    this._vscodeRegistrationStore.clear()
    this._vscodeRegistrationDisposables.clear()
    for (const entry of entries) {
      if (!CommandsRegistry.getCommand(entry.command)) continue
      this._applyEntryToStore(
        entry,
        this._vscodeRegistrationStore,
        this._vscodeRegistrationDisposables,
      )
    }
  }

  private async _reloadVSCodeAndUser(): Promise<void> {
    // Clear user entries first so they can be re-registered after VSCode entries (LIFO order).
    this._registrationStore.clear()
    this._registrationDisposables.clear()
    await this._reloadVSCodeFile()
    await this._reloadFromFile()
  }

  private async _reloadFromFile(): Promise<void> {
    if (this._suspendWriteBack) return
    const text = await this._files.read(UserDataFile.Keybindings)
    const entries = parseKeybindingsFile(text)
    this._suspendWriteBack = true
    try {
      // Drop all previous user-applied registrations.
      this._registrationStore.clear()
      this._registrationDisposables.clear()
      this._userEntries.clear()
      for (const entry of entries) this._applyEntry(entry)
    } finally {
      this._suspendWriteBack = false
    }
    this._onDidChange.fire()
  }

  private _applyEntry(entry: IUserKeybindingEntry): void {
    this._applyEntryToStore(entry, this._registrationStore, this._registrationDisposables)
    this._userEntries.set(entry.command, entry)
  }

  private _applyEntryToStore(
    entry: IUserKeybindingEntry,
    store: DisposableStore,
    disposables: Map<string, IDisposable>,
  ): void {
    // Remove previous registration for this command first.
    const prev = disposables.get(entry.command)
    if (prev) {
      store.delete(prev)
      disposables.delete(entry.command)
    }

    if (entry.key === null) {
      const toNegate: IKeybindingItem[] = KeybindingsRegistry.getAllKeybindings().filter(
        (kb) => kb.command === entry.command && !kb.isNegated,
      )
      if (toNegate.length === 0) return

      const ds: IDisposable[] = toNegate.map((kb) => {
        if (kb.chords) {
          return KeybindingsRegistry.registerKeybinding({
            chords: kb.chords as [string, string],
            command: entry.command,
            isNegated: true,
          })
        }
        return KeybindingsRegistry.registerKeybinding({
          key: kb.key!,
          command: entry.command,
          isNegated: true,
        })
      })

      const combined = combinedDisposable(...ds)
      store.add(combined)
      disposables.set(entry.command, combined)
    } else {
      const item = keyToKeybindingItem(entry)
      if (!item) return
      const d = KeybindingsRegistry.registerKeybinding(item)
      store.add(d)
      disposables.set(entry.command, d)
    }
  }

  private async _writeFile(): Promise<void> {
    const fileEntries = [...this._userEntries.values()].map(entryToFile)
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
