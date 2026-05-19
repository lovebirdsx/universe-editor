/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File-backed sync between IConfigurationService and settings.json /
 *  project settings. Watches the files for external edits and hot-reloads the
 *  matching layer. Programmatic update() calls round-trip through setValue()
 *  so user comments and formatting in settings.json are preserved.
 *--------------------------------------------------------------------------------------------*/

import { parse, type ParseError } from 'jsonc-parser'
import {
  ConfigurationTarget,
  Disposable,
  IConfigurationService,
  IStorageService,
  IUserDataFilesService,
  UserDataFile,
} from '@universe-editor/platform'

export const USER_SETTINGS_KEY = 'workbench.userSettings'

function parseJsoncObject(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || parsed === undefined) return {}
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

export class UserSettingsSync extends Disposable {
  /**
   * Set while a file → layer load is in flight, so onDidChangeConfiguration
   * doesn't trigger another write back to disk (avoids round-trip loops).
   */
  private _suspendWriteBack = false

  /** Last seen User layer snapshot. Used to detect what changed for setValue calls. */
  private _lastUserSnapshot: Record<string, unknown> = {}

  /** Last seen Project layer snapshot. */
  private _lastProjectSnapshot: Record<string, unknown> = {}

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IStorageService private readonly _storage: IStorageService,
    @IUserDataFilesService private readonly _files: IUserDataFilesService,
  ) {
    super()
  }

  async initialize(): Promise<void> {
    await this._migrateLegacyUserSettings()
    await this._reloadUserLayer()
    await this._reloadProjectLayer()

    this._register(
      this._files.onDidChangeFile((file) => {
        if (file === UserDataFile.Settings) {
          void this._reloadUserLayer()
        } else if (file === UserDataFile.ProjectSettings) {
          void this._reloadProjectLayer()
        }
      }),
    )

    // Programmatic update() → propagate the changed keys to settings files so
    // user-visible JSON stays in sync. Both User and Project layers are mirrored.
    this._register(
      this._config.onDidChangeConfiguration(() => {
        if (this._suspendWriteBack) return
        void this._syncLayerToFile(ConfigurationTarget.User, UserDataFile.Settings)
        void this._syncLayerToFile(ConfigurationTarget.Project, UserDataFile.ProjectSettings)
      }),
    )
  }

  private async _reloadUserLayer(): Promise<void> {
    const text = await this._files.read(UserDataFile.Settings)
    const data = parseJsoncObject(text)
    this._suspendWriteBack = true
    try {
      this._config.loadLayer(ConfigurationTarget.User, data)
    } finally {
      this._suspendWriteBack = false
    }
    this._lastUserSnapshot = { ...data }
  }

  private async _reloadProjectLayer(): Promise<void> {
    const text = await this._files.read(UserDataFile.ProjectSettings)
    const data = parseJsoncObject(text)
    this._suspendWriteBack = true
    try {
      this._config.loadLayer(ConfigurationTarget.Project, data)
    } finally {
      this._suspendWriteBack = false
    }
    this._lastProjectSnapshot = { ...data }
  }

  private async _syncLayerToFile(target: ConfigurationTarget, file: UserDataFile): Promise<void> {
    const prev =
      target === ConfigurationTarget.User ? this._lastUserSnapshot : this._lastProjectSnapshot
    const snapshot = this._config.getLayerSnapshot(target)

    const allKeys = new Set([...Object.keys(prev), ...Object.keys(snapshot)])
    const changes: Array<{ key: string; value: unknown | undefined }> = []
    for (const k of allKeys) {
      const next = snapshot[k]
      if (prev[k] !== next) {
        changes.push({ key: k, value: k in snapshot ? next : undefined })
      }
    }
    if (changes.length === 0) return

    for (const { key, value } of changes) {
      await this._files.setValue(file, [key], value)
    }

    if (target === ConfigurationTarget.User) {
      this._lastUserSnapshot = { ...snapshot }
    } else {
      this._lastProjectSnapshot = { ...snapshot }
    }
  }

  private async _migrateLegacyUserSettings(): Promise<void> {
    const existing = await this._files.read(UserDataFile.Settings)
    if (existing.trim() !== '') return
    const legacy = await this._storage.get<Record<string, unknown>>(USER_SETTINGS_KEY)
    if (!legacy || typeof legacy !== 'object' || Object.keys(legacy).length === 0) return
    const body = `// User settings — migrated from previous storage on first launch.\n${JSON.stringify(legacy, null, 2)}\n`
    await this._files.write(UserDataFile.Settings, body)
    // Clear the legacy entry so we don't keep a stale duplicate around.
    await this._storage.set(USER_SETTINGS_KEY, {})
  }
}
