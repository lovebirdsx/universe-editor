/**
 * Host-side registry backing `workspace.createFileSystemWatcher`. Watchers
 * match their glob against the workspace-relative path of each event pushed by
 * the renderer (`IExtHostFileEvents.$acceptFileEvents`); out-of-workspace
 * events never match. The renderer only forwards events while at least one
 * watcher is alive — this registry declares interest via
 * `IMainThreadFileEvents.$subscribeFileEvents` / `$unsubscribeFileEvents` so a
 * host with no watchers costs zero RPC traffic.
 */
import { Emitter, URI, normalizePlatform, relativePathUnder } from '@universe-editor/platform'
import type { UriComponents } from '@universe-editor/extension-api'
import { compileGlobMatcher, type IFileChangeEventDto } from '@universe-editor/extensions-common'
import type { IMainThreadFileEvents } from '@universe-editor/extensions-common'
import type { FileSystemWatcherBridge } from './apiFactory.js'

interface WatcherEntry {
  readonly matches: (relPath: string) => boolean
  readonly ignoreCreateEvents: boolean
  readonly ignoreChangeEvents: boolean
  readonly ignoreDeleteEvents: boolean
  readonly onDidCreate: Emitter<UriComponents>
  readonly onDidChange: Emitter<UriComponents>
  readonly onDidDelete: Emitter<UriComponents>
}

export class HostFileWatcherRegistry {
  private readonly _entries = new Set<WatcherEntry>()
  private _subscribed = false

  constructor(
    private readonly _mainThread: IMainThreadFileEvents,
    private readonly _workspaceRoot: string | undefined,
  ) {}

  createWatcher(
    globPattern: string,
    ignoreCreateEvents: boolean,
    ignoreChangeEvents: boolean,
    ignoreDeleteEvents: boolean,
  ): FileSystemWatcherBridge {
    const entry: WatcherEntry = {
      matches: compileGlobMatcher(globPattern),
      ignoreCreateEvents,
      ignoreChangeEvents,
      ignoreDeleteEvents,
      onDidCreate: new Emitter<UriComponents>(),
      onDidChange: new Emitter<UriComponents>(),
      onDidDelete: new Emitter<UriComponents>(),
    }
    this._entries.add(entry)
    this._syncSubscription()
    return {
      ignoreCreateEvents,
      ignoreChangeEvents,
      ignoreDeleteEvents,
      onDidCreate: entry.onDidCreate.event,
      onDidChange: entry.onDidChange.event,
      onDidDelete: entry.onDidDelete.event,
      dispose: () => {
        if (!this._entries.delete(entry)) return
        entry.onDidCreate.dispose()
        entry.onDidChange.dispose()
        entry.onDidDelete.dispose()
        this._syncSubscription()
      },
    }
  }

  /** IExtHostFileEvents.$acceptFileEvents */
  acceptFileEvents(events: readonly IFileChangeEventDto[]): void {
    const root = this._workspaceRoot
    if (this._entries.size === 0 || root === undefined) return
    const platform = normalizePlatform(process.platform)
    for (const event of events) {
      const fsPath = URI.revive(event.uri)?.fsPath
      if (fsPath === undefined) continue
      const rel = relativePathUnder(root, fsPath, platform)
      if (rel === null || rel === '') continue
      for (const entry of this._entries) {
        if (!entry.matches(rel)) continue
        if (event.type === 'created' && !entry.ignoreCreateEvents) {
          entry.onDidCreate.fire(event.uri)
        } else if (event.type === 'changed' && !entry.ignoreChangeEvents) {
          entry.onDidChange.fire(event.uri)
        } else if (event.type === 'deleted' && !entry.ignoreDeleteEvents) {
          entry.onDidDelete.fire(event.uri)
        }
      }
    }
  }

  dispose(): void {
    for (const entry of this._entries) {
      entry.onDidCreate.dispose()
      entry.onDidChange.dispose()
      entry.onDidDelete.dispose()
    }
    this._entries.clear()
    this._syncSubscription()
  }

  private _syncSubscription(): void {
    const want = this._entries.size > 0
    if (want === this._subscribed) return
    this._subscribed = want
    const pending = want
      ? this._mainThread.$subscribeFileEvents()
      : this._mainThread.$unsubscribeFileEvents()
    void pending.catch((err: unknown) => {
      console.warn(`[ext-host] file-events subscription flip failed: ${(err as Error).message}`)
    })
  }
}
