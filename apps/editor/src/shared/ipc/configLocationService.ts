/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the config directory: the location user-level settings.json
 *  and keybindings.json are loaded from. Defaults to userData; a user can relocate
 *  it to any directory (VSCode Portable style). The pointer persists in
 *  <userData>/config-location.json; cli/env overrides outrank it.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export interface IConfigLocationInfo {
  /** Absolute directory user settings/keybindings load from. */
  readonly dir: string
  /** Where the value came from: 'cli' | 'env' | 'file' | 'default'. */
  readonly origin: string
  /** True when locked by cli/env — the UI cannot change it this session. */
  readonly locked: boolean
}

export interface IConfigLocationService {
  readonly _serviceBrand: undefined

  /** Fires after the active config directory changes (UI relocate / reset). */
  readonly onDidChangeConfigDir: Event<string>

  /** Current config directory and its provenance. */
  getInfo(): Promise<IConfigLocationInfo>

  /**
   * Relocate user settings/keybindings to `dir`. Persists the pointer and
   * hot-reloads every open window. When `copyCurrent` is true, the existing
   * settings.json / keybindings.json are copied into `dir` first (skipped for
   * files that already exist there). No-op (returns false) when locked by cli/env.
   */
  setConfigDir(dir: string, copyCurrent: boolean): Promise<boolean>

  /** Clear the persisted pointer, reverting to userData. No-op when locked. */
  resetToDefault(): Promise<boolean>

  /** True when `dir` exists and contains at least one entry. */
  isDirNonEmpty(dir: string): Promise<boolean>
}

export const IConfigLocationService =
  createDecorator<IConfigLocationService>('configLocationService')
