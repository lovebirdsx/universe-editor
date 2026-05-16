/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridges IConfigurationService (User layer) and IStorageService:
 *   - On initialize(): pulls stored user settings into the User layer.
 *   - On every change: serialises the User layer snapshot back to storage.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  Disposable,
  IConfigurationService,
  IStorageService,
} from '@universe-editor/platform'

export const USER_SETTINGS_KEY = 'workbench.userSettings'

export class UserSettingsSync extends Disposable {
  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IStorageService private readonly _storage: IStorageService,
  ) {
    super()
  }

  /**
   * Loads the persisted User layer from storage and starts mirroring writes
   * back. Safe to call once during bootstrap; subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    const raw = (await this._storage.get<Record<string, unknown>>(USER_SETTINGS_KEY)) ?? {}
    this._config.loadLayer(ConfigurationTarget.User, raw)

    this._register(
      this._config.onDidChangeConfiguration(() => {
        const snapshot = this._config.getLayerSnapshot(ConfigurationTarget.User)
        void this._storage.set(USER_SETTINGS_KEY, snapshot)
      }),
    )
  }
}
