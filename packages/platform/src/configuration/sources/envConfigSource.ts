/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Environment-variable source. Reads any env key declared on the item.
 *--------------------------------------------------------------------------------------------*/

import type { ConfigItem, IConfigSource, RawConfigValue } from './configSource.js'

export class EnvConfigSource implements IConfigSource {
  readonly name = 'env'

  constructor(private readonly _env: Readonly<Record<string, string | undefined>>) {}

  getRawValue(item: ConfigItem): RawConfigValue {
    const key = item.env
    if (!key) return undefined
    return this._env[key]
  }
}
