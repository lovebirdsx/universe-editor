/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IUserDataFilesService — file-backed user data (settings.json / keybindings.json /
 *  project settings). Implementation lives in the main process; renderer accesses
 *  it through ProxyChannel. Watches files for external edits and emits change
 *  events so subscribers can hot-reload.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import type { UriComponents } from '../base/uri.js'
import { createDecorator } from '../di/instantiation.js'

export const enum UserDataFile {
  /** Global user settings: `<userData>/settings.json`. */
  Settings = 'settings',
  /** Global keybinding overrides: `<userData>/keybindings.json`. */
  Keybindings = 'keybindings',
  /** AI provider groups & per-model config: `<userData>/aiModels.json`. */
  AiModels = 'aiModels',
  /** Project-level settings: `<workspace>/.universe-editor/settings.json`. */
  ProjectSettings = 'projectSettings',
  /** Read-only VSCode-compatible workspace settings: `<workspace>/.vscode/settings.json`. */
  VSCodeSettings = 'vscodeSettings',
  /** Read-only VSCode user settings: `<vscodeUserData>/settings.json`. */
  VSCodeUserSettings = 'vscodeUserSettings',
  /** Read-only VSCode user keybindings: `<vscodeUserData>/keybindings.json`. */
  VSCodeKeybindings = 'vscodeKeybindings',
}

export interface IUserDataFilesService {
  readonly _serviceBrand: undefined

  /**
   * Fired when a watched file changes on disk *from outside this service*.
   * Self-writes via write()/setValue() are suppressed within a short window so
   * subscribers see one logical change at a time.
   */
  readonly onDidChangeFile: Event<UserDataFile>

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
  getFileUri(file: UserDataFile): Promise<UriComponents | null>
}

export const IUserDataFilesService = createDecorator<IUserDataFilesService>('userDataFilesService')
