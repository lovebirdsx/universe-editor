/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPromptHistoryService — global, persistent store of recently-sent prompt texts.
 *
 *  Stored in GLOBAL scope so history is shared across all workspaces and worktrees.
 *  Entries are ordered newest-first. Duplicate texts are moved to the front on push.
 *  The maximum entry count is configurable via `acp.prompt.historyMaxEntries`.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  IConfigurationService,
  IStorageService,
  StorageScope,
  observableValue,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'

export interface IAcpPromptHistoryService {
  readonly _serviceBrand: undefined
  /** Sent prompts, newest-first. */
  readonly entries: IObservable<readonly string[]>
  /** Add a prompt to history, deduplicating and trimming to the configured max. */
  push(text: string): void
}

export const IAcpPromptHistoryService =
  createDecorator<IAcpPromptHistoryService>('acpPromptHistoryService')

const STORAGE_KEY = 'acp.promptHistory.entries'
const DEFAULT_MAX_ENTRIES = 50

export class AcpPromptHistoryService extends Disposable implements IAcpPromptHistoryService {
  declare readonly _serviceBrand: undefined

  private readonly _entries: ISettableObservable<readonly string[]> = observableValue<
    readonly string[]
  >('acpPromptHistory', [])

  readonly entries: IObservable<readonly string[]> = this._entries

  constructor(
    @IStorageService private readonly _storage: IStorageService,
    @IConfigurationService private readonly _config: IConfigurationService,
  ) {
    super()
    void this._load()
  }

  private async _load(): Promise<void> {
    const saved = await this._storage.get<string[]>(STORAGE_KEY, StorageScope.GLOBAL)
    if (Array.isArray(saved) && saved.length > 0) {
      this._entries.set(saved, undefined)
    }
  }

  push(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const maxEntries =
      this._config.get<number>('acp.prompt.historyMaxEntries') ?? DEFAULT_MAX_ENTRIES
    const current = this._entries.get()
    const deduped = [trimmed, ...current.filter((e) => e !== trimmed)].slice(0, maxEntries)
    this._entries.set(deduped, undefined)
    void this._storage.set(STORAGE_KEY, deduped, StorageScope.GLOBAL)
  }
}
