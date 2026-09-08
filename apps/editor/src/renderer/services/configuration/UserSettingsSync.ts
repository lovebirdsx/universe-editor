/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File-backed sync between IConfigurationService and settings.json /
 *  project settings. Watches the files for external edits and hot-reloads the
 *  matching layer. Programmatic update() calls round-trip through setValue()
 *  so user comments and formatting in settings.json are preserved.
 *
 *  Editing a user-data file *inside the workbench* and saving it writes the
 *  file through IFileService (FileEditorInput.save), which bypasses the
 *  UserDataMainService atomic-write path — and the main-side fs.watch on the
 *  user-data directory is unreliable on Windows for plain overwrites (events
 *  get coalesced/dropped), so the in-memory layer silently stayed stale until
 *  a window reload. We therefore also subscribe to DidSaveNotification and
 *  reload the matching layer on every in-workbench save of a user-data file.
 *  This reload is idempotent with the watcher-driven one (loadLayer diffs by
 *  content and only fires for effective changes).
 *--------------------------------------------------------------------------------------------*/

import { parse, type ParseError } from 'jsonc-parser'
import {
  ConfigurationTarget,
  createDecorator,
  DeferredPromise,
  Disposable,
  IConfigurationService,
  InstantiationType,
  IStorageService,
  IUriIdentityService,
  IUserDataFilesService,
  registerSingleton,
  URI,
  UserDataFile,
} from '@universe-editor/platform'
import { DidSaveNotification } from '../extensions/DidSaveNotification.js'

export const USER_SETTINGS_KEY = 'workbench.userSettings'

export interface IUserSettingsSyncService {
  readonly _serviceBrand: undefined
  /**
   * Resolves once the initial file → layer hydration has completed (all
   * layers). One-shot startup actions that read configuration (e.g. a
   * cold-launch deep link picking `acp.defaultAgentId`) must await this —
   * `initialize()` is fired-and-forgotten from ConfigInitContribution, so a
   * fast bootstrap can otherwise reach AfterRestore before settings.json is in.
   */
  readonly whenInitialized: Promise<void>
  initialize(): Promise<void>
}

export const IUserSettingsSyncService =
  createDecorator<IUserSettingsSyncService>('userSettingsSyncService')

function parseJsoncObject(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || parsed === undefined) return {}
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

export class UserSettingsSync extends Disposable implements IUserSettingsSyncService {
  declare readonly _serviceBrand: undefined

  private readonly _initialized = new DeferredPromise<void>()
  readonly whenInitialized = this._initialized.p

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
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
  ) {
    super()
  }

  async initialize(): Promise<void> {
    try {
      await this._migrateLegacyUserSettings()
      await this._reloadVSCodeUserLayer()
      await this._reloadUserLayer()
      await this._reloadProjectLayer()
      await this._reloadVSCodeLayer()
    } finally {
      // Settle even on failure so whenInitialized awaiters never deadlock.
      this._initialized.complete(undefined)
    }

    this._register(
      this._files.onDidChangeFile(({ file, source }) => {
        // Self-writes already updated the in-memory layer; re-reading is a no-op
        // round trip. Open editors are refreshed separately by ExternalChangeWatcher.
        if (source === 'self') return
        if (file === UserDataFile.Settings) {
          void this._reloadUserLayer()
        } else if (file === UserDataFile.ProjectSettings) {
          void this._reloadProjectLayer()
        } else if (file === UserDataFile.VSCodeSettings) {
          void this._reloadVSCodeLayer()
        } else if (file === UserDataFile.VSCodeUserSettings) {
          void this._reloadVSCodeUserLayer()
        }
      }),
    )

    // In-workbench saves of a user-data file bypass UserDataMainService's
    // atomic-write path (FileEditorInput.save writes via IFileService), and the
    // main-side fs.watch is unreliable on Windows for those plain overwrites —
    // so the file changed on disk without any onDidChangeFile reaching us and
    // the layer went stale until a window reload. Reload the matching layer on
    // every save notification whose URI is one of our user-data files. Idempotent
    // with the watcher path: a save that the watcher did see just re-reads the
    // same content and loadLayer fires nothing.
    this._register(
      DidSaveNotification.register((uri) => {
        void this._reloadLayerForSavedUri(uri)
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

  /**
   * Load the read-only VSCode-compatible workspace layer
   * (`<workspace>/.vscode/settings.json`). Never written back — this layer only
   * mirrors disk, so it has no snapshot tracking.
   */
  private async _reloadVSCodeLayer(): Promise<void> {
    const text = await this._files.read(UserDataFile.VSCodeSettings)
    const data = parseJsoncObject(text)
    this._suspendWriteBack = true
    try {
      this._config.loadLayer(ConfigurationTarget.VSCodeWorkspace, data)
    } finally {
      this._suspendWriteBack = false
    }
  }

  /**
   * Load the read-only VSCode user-settings layer
   * (`<vscodeUserData>/settings.json`). Never written back; sits below the
   * editor's own User layer so local settings win on conflict.
   */
  private async _reloadVSCodeUserLayer(): Promise<void> {
    const text = await this._files.read(UserDataFile.VSCodeUserSettings)
    const data = parseJsoncObject(text)
    this._suspendWriteBack = true
    try {
      this._config.loadLayer(ConfigurationTarget.VSCodeUser, data)
    } finally {
      this._suspendWriteBack = false
    }
  }

  /**
   * Reload the layer backing a just-saved user-data file, if `uri` is one of
   * them. Called from DidSaveNotification: an in-workbench save writes through
   * IFileService, bypassing the atomic-write self-notification, and the
   * main-side fs.watch can silently miss those overwrites on Windows.
   */
  private async _reloadLayerForSavedUri(uri: URI): Promise<void> {
    const candidates: Array<{ file: UserDataFile; reload: () => Promise<void> }> = [
      { file: UserDataFile.Settings, reload: () => this._reloadUserLayer() },
      { file: UserDataFile.ProjectSettings, reload: () => this._reloadProjectLayer() },
      { file: UserDataFile.VSCodeSettings, reload: () => this._reloadVSCodeLayer() },
      { file: UserDataFile.VSCodeUserSettings, reload: () => this._reloadVSCodeUserLayer() },
    ]
    const key = this._uriIdentity.getComparisonKey(uri)
    for (const { file, reload } of candidates) {
      let fileUri: URI | null = null
      try {
        fileUri = await this._files.getFileUri(file)
      } catch {
        continue
      }
      if (fileUri && this._uriIdentity.getComparisonKey(fileUri) === key) {
        await reload()
        return
      }
    }
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

registerSingleton(IUserSettingsSyncService, UserSettingsSync, InstantiationType.Delayed)
