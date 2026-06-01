/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File source. Reads from an already-parsed JSON object by the item's dotted
 *  `filePath`. Does NOT touch the filesystem — callers parse the file and inject
 *  the object, keeping platform free of fs dependencies and easy to unit-test.
 *--------------------------------------------------------------------------------------------*/

import type { ConfigItem, IConfigSource, RawConfigValue } from './configSource.js'

export class FileConfigSource implements IConfigSource {
  readonly name = 'file'

  constructor(private readonly _data: Readonly<Record<string, unknown>>) {}

  getRawValue(item: ConfigItem): RawConfigValue {
    const path = item.filePath
    if (!path) return undefined

    let cursor: unknown = this._data
    for (const segment of path.split('.')) {
      if (cursor === null || typeof cursor !== 'object') return undefined
      cursor = (cursor as Record<string, unknown>)[segment]
    }

    if (typeof cursor === 'string' || typeof cursor === 'boolean') return cursor
    if (Array.isArray(cursor) && cursor.every((v) => typeof v === 'string')) {
      return cursor as string[]
    }
    return undefined
  }
}
