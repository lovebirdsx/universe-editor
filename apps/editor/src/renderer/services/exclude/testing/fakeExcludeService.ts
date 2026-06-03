/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test helper: a permissive IExcludeService that excludes nothing. Lets tests
 *  that construct exclude-aware services (Explorer / search / quick open) wire a
 *  no-op dependency without pulling in real configuration.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '@universe-editor/platform'
import { type ExcludeKind, type IExcludeService } from '../ExcludeService.js'

export class FakeExcludeService implements IExcludeService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(
    private readonly _excluded: ReadonlySet<string> = new Set(),
    readonly currentWatcherGlobs: readonly string[] = [],
  ) {}

  isExcluded(relPath: string, _kind: ExcludeKind): boolean {
    return this._excluded.has(relPath)
  }

  getDirNameIgnores(): string[] {
    return []
  }

  getSearchExcludeGlobs(): string[] {
    return []
  }

  fireChange(): void {
    this._onDidChange.fire()
  }
}
