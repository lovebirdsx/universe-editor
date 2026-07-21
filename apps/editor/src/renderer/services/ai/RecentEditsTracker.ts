/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RecentEditsTracker — a per-file ring buffer of the user's recent edits, the raw
 *  material a Next Edit Suggestion needs to predict the *next* change. It is fed
 *  raw Monaco content-change records by FileEditor (so it stays Monaco-free and
 *  node-testable) and surfaces a compact, oldest-first history to
 *  InlineCompletionService. Records store only the delta (line + inserted text +
 *  deleted length); content-change events carry no old text. Same-line edits made
 *  in quick succession are coalesced so per-keystroke events don't flood the
 *  buffer.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IUriIdentityService,
  InstantiationType,
  URI,
  createDecorator,
  registerSingleton,
} from '@universe-editor/platform'

const CONFIG_COUNT = 'ai.nes.recentEditsCount'
const DEFAULT_COUNT = 10

// Merge consecutive same-line edits issued within this window into one record.
const COALESCE_WINDOW_MS = 2000

export interface IRecentEdit {
  /** 1-based line where the change began. */
  lineNumber: number
  /** Text that was inserted (empty for a pure deletion). */
  inserted: string
  /** Number of characters removed by the change. */
  deletedLength: number
  /** Epoch ms when the change was recorded. */
  at: number
}

/** Minimal shape of a Monaco content change; FileEditor passes `event.changes`. */
export interface IContentChangeLike {
  readonly range: { readonly startLineNumber: number }
  readonly text: string
  readonly rangeLength: number
}

export interface IRecentEditsTracker {
  readonly _serviceBrand: undefined
  /** Append the changes from one content-change event for `uri`. */
  record(uri: string, changes: ReadonlyArray<IContentChangeLike>): void
  /** Recent edits for `uri`, oldest first. */
  getRecentEdits(uri: string): readonly IRecentEdit[]
  /** Forget the history for `uri` (e.g. when the file is closed). */
  clear(uri: string): void
}

export const IRecentEditsTracker = createDecorator<IRecentEditsTracker>('recentEditsTracker')

export class RecentEditsTracker extends Disposable implements IRecentEditsTracker {
  declare readonly _serviceBrand: undefined

  private readonly _byUri = new Map<string, IRecentEdit[]>()

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
  ) {
    super()
    this._register({ dispose: () => this._byUri.clear() })
  }

  record(uri: string, changes: ReadonlyArray<IContentChangeLike>): void {
    if (changes.length === 0) return
    const key = this._key(uri)
    const buffer = this._byUri.get(key) ?? []
    const now = Date.now()
    for (const change of changes) {
      const edit: IRecentEdit = {
        lineNumber: change.range.startLineNumber,
        inserted: change.text,
        deletedLength: change.rangeLength,
        at: now,
      }
      const last = buffer[buffer.length - 1]
      if (
        last !== undefined &&
        last.lineNumber === edit.lineNumber &&
        now - last.at < COALESCE_WINDOW_MS
      ) {
        last.inserted += edit.inserted
        last.deletedLength += edit.deletedLength
        last.at = now
      } else {
        buffer.push(edit)
      }
    }
    const limit = this._limit()
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit)
    this._byUri.set(key, buffer)
  }

  getRecentEdits(uri: string): readonly IRecentEdit[] {
    return this._byUri.get(this._key(uri)) ?? []
  }

  clear(uri: string): void {
    this._byUri.delete(this._key(uri))
  }

  // FileEditor records under the platform URI (drive letter as written) while
  // InlineCompletionService reads under the Monaco model URI (drive letter
  // lower-cased after a round-trip). Use the platform-aware comparison key so
  // both resolve to one file.
  private _key(uri: string): string {
    try {
      return this._uriIdentity.getComparisonKey(URI.parse(uri))
    } catch {
      return uri
    }
  }

  private _limit(): number {
    const value = this._config.get<number>(CONFIG_COUNT)
    return typeof value === 'number' && value > 0 ? value : DEFAULT_COUNT
  }
}

registerSingleton(IRecentEditsTracker, RecentEditsTracker, InstantiationType.Eager)
