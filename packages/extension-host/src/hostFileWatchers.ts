/**
 * Host-side registry backing `workspace.createFileSystemWatcher`. Watchers
 * match their glob against the workspace-relative path of each event pushed by
 * the renderer (`IExtHostFileEvents.$acceptFileEvents`). A `RelativePattern`
 * watcher instead matches its `pattern` against the path relative to its
 * `base` folder — including a base outside the workspace, whose events the
 * renderer arms an out-of-workspace watch for. An absolute string glob is
 * split the same way: its literal root becomes the base. The renderer only
 * forwards events while at least one watcher is alive — every watcher
 * declares interest via `IMainThreadFileEvents.$subscribeFileEvents(base)` /
 * `$unsubscribeFileEvents(base)` so a host with no watchers costs zero RPC
 * traffic.
 */
import { Emitter, URI, normalizePlatform, relativePathUnder } from '@universe-editor/platform'
import type { GlobPattern, UriComponents } from '@universe-editor/extension-api'
import { compileGlobMatcher, type IFileChangeEventDto } from '@universe-editor/extensions-common'
import type { IMainThreadFileEvents } from '@universe-editor/extensions-common'
import type { FileSystemWatcherBridge } from './apiFactory.js'

const HAS_GLOB_CHARS = /[*?{[]/

/**
 * Split an absolute glob into its literal root folder and the remaining
 * base-relative pattern (VSCode RelativePattern semantics), or null when the
 * pattern is workspace-relative. A glob-free absolute path targets a single
 * entry: base is its parent folder, pattern its basename.
 */
export function splitAbsoluteGlob(pattern: string): { base: string; pattern: string } | null {
  const normalized = pattern.replace(/\\/g, '/')
  const anchored =
    normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
  if (!anchored) return null
  const segments = normalized.split('/')
  let cut = segments.findIndex((s) => HAS_GLOB_CHARS.test(s))
  if (cut === -1) cut = segments.length - 1
  if (cut <= 0) return null
  const base = segments.slice(0, cut).join('/')
  const rest = segments.slice(cut).join('/')
  // The drive root alone ('D:') can't anchor a watch.
  if (base === '' || /^[A-Za-z]:$/.test(base) || rest === '') return null
  return { base, pattern: rest }
}

interface WatcherEntry {
  readonly matches: (relPath: string) => boolean
  /** fsPath of the folder events are matched relative to; undefined watches the whole workspace. */
  readonly base: string | undefined
  readonly ignoreCreateEvents: boolean
  readonly ignoreChangeEvents: boolean
  readonly ignoreDeleteEvents: boolean
  readonly onDidCreate: Emitter<UriComponents>
  readonly onDidChange: Emitter<UriComponents>
  readonly onDidDelete: Emitter<UriComponents>
}

export class HostFileWatcherRegistry {
  private readonly _entries = new Set<WatcherEntry>()

  constructor(
    private readonly _mainThread: IMainThreadFileEvents,
    private readonly _workspaceRoot: string | undefined,
  ) {}

  createWatcher(
    globPattern: GlobPattern,
    ignoreCreateEvents: boolean,
    ignoreChangeEvents: boolean,
    ignoreDeleteEvents: boolean,
  ): FileSystemWatcherBridge {
    let base: string | undefined
    let pattern: string
    if (typeof globPattern === 'string') {
      const split = splitAbsoluteGlob(globPattern)
      base = split?.base
      pattern = split?.pattern ?? globPattern
    } else {
      base = globPattern.base
      pattern = globPattern.pattern
    }
    const entry: WatcherEntry = {
      matches: compileGlobMatcher(pattern),
      base,
      ignoreCreateEvents,
      ignoreChangeEvents,
      ignoreDeleteEvents,
      onDidCreate: new Emitter<UriComponents>(),
      onDidChange: new Emitter<UriComponents>(),
      onDidDelete: new Emitter<UriComponents>(),
    }
    this._entries.add(entry)
    this._declareInterest(entry, true)
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
        this._declareInterest(entry, false)
      },
    }
  }

  /** IExtHostFileEvents.$acceptFileEvents */
  acceptFileEvents(events: readonly IFileChangeEventDto[]): void {
    const root = this._workspaceRoot
    if (this._entries.size === 0) return
    const platform = normalizePlatform(process.platform)
    for (const event of events) {
      const fsPath = URI.revive(event.uri)?.fsPath
      if (fsPath === undefined) continue
      for (const entry of this._entries) {
        const anchor = entry.base ?? root
        if (anchor === undefined) continue
        const rel = relativePathUnder(anchor, fsPath, platform)
        if (rel === null || rel === '') continue
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
      this._declareInterest(entry, false)
    }
    this._entries.clear()
  }

  private _declareInterest(entry: WatcherEntry, subscribe: boolean): void {
    const base = entry.base === undefined ? undefined : URI.file(entry.base).toJSON()
    const pending = subscribe
      ? this._mainThread.$subscribeFileEvents(base)
      : this._mainThread.$unsubscribeFileEvents(base)
    void pending.catch((err: unknown) => {
      console.warn(`[ext-host] file-events subscription flip failed: ${(err as Error).message}`)
    })
  }
}
