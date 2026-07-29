/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OutOfWorkspaceWatchService —— IFileWatcherService.watchOutOfWorkspace 的
 * 多消费者聚合层。底层接口是全量替换语义，直接多调会互相覆盖（打开的外部
 * 文件 vs 主题文件）；这里按批次持有各消费者的 URI 集合并做并集，任一变化
 * 时合并下发一次。
 */

import {
  createDecorator,
  IFileWatcherService,
  InstantiationType,
  registerSingleton,
  type IDisposable,
  type URI,
} from '@universe-editor/platform'

export interface IOutOfWorkspaceWatchService {
  readonly _serviceBrand: undefined
  /** Register a batch of out-of-workspace URIs to watch; dispose to unwatch. */
  watch(uris: readonly URI[]): IDisposable
}

export const IOutOfWorkspaceWatchService = createDecorator<IOutOfWorkspaceWatchService>(
  'outOfWorkspaceWatchService',
)

export class OutOfWorkspaceWatchService implements IOutOfWorkspaceWatchService {
  declare readonly _serviceBrand: undefined

  private _nextId = 1
  private readonly _batches = new Map<number, readonly URI[]>()

  constructor(@IFileWatcherService private readonly _watcher: IFileWatcherService) {}

  watch(uris: readonly URI[]): IDisposable {
    const id = this._nextId++
    this._batches.set(id, uris)
    void this._apply()
    return {
      dispose: () => {
        if (this._batches.delete(id)) {
          void this._apply()
        }
      },
    }
  }

  private async _apply(): Promise<void> {
    const merged: URI[] = []
    const seen = new Set<string>()
    for (const batch of this._batches.values()) {
      for (const uri of batch) {
        const key = uri.toString()
        if (!seen.has(key)) {
          seen.add(key)
          merged.push(uri)
        }
      }
    }
    await this._watcher.watchOutOfWorkspace(merged)
  }
}

registerSingleton(
  IOutOfWorkspaceWatchService,
  OutOfWorkspaceWatchService,
  InstantiationType.Delayed,
)
