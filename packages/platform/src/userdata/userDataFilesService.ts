/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IUserDataFilesService — file-backed user data (settings.json / keybindings.json /
 *  project settings). Implementation lives in the main process; renderer accesses
 *  it through ProxyChannel. Watches files for external edits and emits change
 *  events so subscribers can hot-reload.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { URI } from '../base/uri.js'
import { createDecorator } from '../di/instantiation.js'

export const enum UserDataFile {
  /** Global user settings: `<userData>/settings.json`. */
  Settings = 'settings',
  /** Global keybinding overrides: `<userData>/keybindings.json`. */
  Keybindings = 'keybindings',
  /** AI configuration (provider groups, per-model config, active models): `<userData>/aiSettings.json`. */
  AiSettings = 'aiSettings',
  /**
   * Deployment config for auto-update (e.g. `updateUrl` feed override).
   * Always `<userData>/update-config.json` — pinned to userData, not the
   * relocatable config directory.
   */
  UpdateConfig = 'updateConfig',
  /** Project-level settings: `<workspace>/.universe-editor/settings.json`. */
  ProjectSettings = 'projectSettings',
  /** Read-only VSCode-compatible workspace settings: `<workspace>/.vscode/settings.json`. */
  VSCodeSettings = 'vscodeSettings',
  /** Read-only VSCode user settings: `<vscodeUserData>/settings.json`. */
  VSCodeUserSettings = 'vscodeUserSettings',
  /** Read-only VSCode user keybindings: `<vscodeUserData>/keybindings.json`. */
  VSCodeKeybindings = 'vscodeKeybindings',
}

/** Describes who triggered a user-data file change. */
export interface IUserDataFileChange {
  readonly file: UserDataFile
  /**
   * 'self' — written by this service (write()/setValue()); 'external' — an
   * on-disk edit from outside, a workspace switch, or a config-dir relocate.
   * Config-layer subscribers ignore 'self' (the in-memory layer is already
   * current) while open editors reload on both so their buffer tracks disk.
   */
  readonly source: 'self' | 'external'
}

export interface IUserDataFilesService {
  readonly _serviceBrand: undefined

  /**
   * Fired when a watched file changes, carrying the source so subscribers can
   * tell self-writes from external edits.
   */
  readonly onDidChangeFile: Event<IUserDataFileChange>

  /**
   * Read raw file text. Returns '' if the file does not exist (or, for
   * ProjectSettings, when no workspace is open).
   */
  read(file: UserDataFile): Promise<string>

  /**
   * Overwrite the entire file contents. Parent dirs are created on demand.
   * Atomic write (temp file + rename) so readers never see truncated content.
   */
  write(file: UserDataFile, content: string): Promise<void>

  /**
   * Modify a single JSONC path while preserving comments and formatting.
   * `value === undefined` removes the key. No-op (returns false) when the
   * target file is ProjectSettings and no workspace is open.
   */
  setValue(
    file: UserDataFile,
    jsonPath: readonly (string | number)[],
    value: unknown,
  ): Promise<boolean>

  /**
   * Absolute path to the backing file. Returns null when the file is
   * unavailable (ProjectSettings without a workspace).
   */
  getFileUri(file: UserDataFile): Promise<URI | null>
}

export const IUserDataFilesService = createDecorator<IUserDataFilesService>('userDataFilesService')
