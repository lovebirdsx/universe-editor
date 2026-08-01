/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Environment-variable source. Reads any env key declared on the item. `string[]`
 *  items split a single env value on path.delimiter (`;` on win32, `:` elsewhere) —
 *  Windows paths contain `:` so a hardcoded `:` separator would corrupt them.
 *--------------------------------------------------------------------------------------------*/

import { delimiter } from 'node:path'
import type { ConfigItem, IConfigSource, RawConfigValue } from './configSource.js'

export class EnvConfigSource implements IConfigSource {
  readonly name = 'env'

  constructor(private readonly _env: Readonly<Record<string, string | undefined>>) {}

  getRawValue(item: ConfigItem): RawConfigValue {
    const key = item.env
    if (!key) return undefined
    const value = this._env[key]
    if (item.type === 'string[]' && value !== undefined) {
      const parts = value.split(delimiter).filter((p) => p !== '')
      return parts.length > 0 ? parts : undefined
    }
    return value
  }
}
