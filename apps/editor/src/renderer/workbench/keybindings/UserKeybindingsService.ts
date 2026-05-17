/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  User keybinding overrides: load from storage on startup, apply to
 *  KeybindingsRegistry at runtime, persist changes back to storage.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  type Event,
  type IDisposable,
  IStorageService,
  KeybindingsRegistry,
  type IKeybindingItem,
} from '@universe-editor/platform'
import { formatKey, formatChord } from '../titlebar/keybindingFormat.js'

export interface IUserKeybindingEntry {
  command: string
  /** Normalized key string (e.g. 'ctrl+shift+b'). null = disable default bindings. */
  key: string | null
  when?: string
}

export interface IUserKeybindingsService {
  readonly _serviceBrand: undefined
  readonly onDidChange: Event<void>
  readonly userEntries: readonly IUserKeybindingEntry[]
  /** Load persisted entries and apply them. Call once during bootstrap. */
  initialize(): Promise<void>
  setKeybinding(command: string, key: string | null, when?: string): void
  resetKeybinding(command: string): void
  getUserEntry(command: string): IUserKeybindingEntry | undefined
  /** Formatted display string for the command's default (pre-user) keybinding. */
  getDefaultKey(command: string): string | undefined
}

export const IUserKeybindingsService =
  createDecorator<IUserKeybindingsService>('userKeybindingsService')

const STORAGE_KEY = 'workbench.userKeybindings'

export class UserKeybindingsService extends Disposable implements IUserKeybindingsService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  private readonly _userEntries = new Map<string, IUserKeybindingEntry>()
  private readonly _registrationDisposables = new Map<string, IDisposable>()
  private readonly _defaultSnapshot = new Map<string, string>()

  constructor(@IStorageService private readonly _storage: IStorageService) {
    super()
    // Snapshot defaults now — all registerAction2() calls have already run (they
    // execute synchronously when their modules are imported, which happens before
    // bootstrapWorkbench() runs).
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
    const stored = (await this._storage.get<IUserKeybindingEntry[]>(STORAGE_KEY)) ?? []
    for (const entry of stored) {
      this._applyEntry(entry)
    }
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
    this._save()
    this._onDidChange.fire()
  }

  resetKeybinding(command: string): void {
    const d = this._registrationDisposables.get(command)
    if (d) {
      d.dispose()
      this._registrationDisposables.delete(command)
    }
    this._userEntries.delete(command)
    this._save()
    this._onDidChange.fire()
  }

  private _applyEntry(entry: IUserKeybindingEntry): void {
    // Remove previous user registration for this command first.
    const prev = this._registrationDisposables.get(entry.command)
    if (prev) {
      prev.dispose()
      this._registrationDisposables.delete(entry.command)
    }

    this._userEntries.set(entry.command, entry)

    if (entry.key === null) {
      // Disable all current (default) bindings for this command.
      const toNegate: IKeybindingItem[] = KeybindingsRegistry.getAllKeybindings().filter(
        (kb) => kb.command === entry.command && !kb.isNegated,
      )
      if (toNegate.length === 0) return

      const disposables: IDisposable[] = toNegate.map((kb) => {
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

      this._registrationDisposables.set(entry.command, {
        dispose: () => disposables.forEach((d) => d.dispose()),
      })
    } else {
      // Register new binding (LIFO means it takes priority over defaults).
      const d = KeybindingsRegistry.registerKeybinding({
        key: entry.key,
        command: entry.command,
        ...(entry.when !== undefined ? { when: entry.when } : {}),
      })
      this._registrationDisposables.set(entry.command, d)
    }
  }

  private _save(): void {
    void this._storage.set(STORAGE_KEY, [...this._userEntries.values()])
  }

  override dispose(): void {
    for (const d of this._registrationDisposables.values()) {
      d.dispose()
    }
    this._registrationDisposables.clear()
    super.dispose()
  }
}
