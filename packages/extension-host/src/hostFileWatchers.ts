/**
 * Host-side registry backing `workspace.createFileSystemWatcher`. Watchers
 * match their glob against the workspace-relative path of each event pushed by
 * the renderer (`IExtHostFileEvents.$acceptFileEvents`). A `RelativePattern`
 * watcher instead matches its `pattern` against the path relative to its
 * `base` folder — including a base outside the workspace, whose events the
 * renderer arms an out-of-workspace watch for. An absolute string glob is
 * split the same way: its literal root becomes the base.
 *
 * Interests are declared to the renderer as `{base, pattern}` pairs,
 * reference-counted per unique pair so only the 0↔n transitions cross the
 * wire (`IMainThreadFileEvents.$subscribeFileEvents` /
 * `$unsubscribeFileEvents`): 50 watchers sharing a glob cost a single pair of
 * calls, and a host with no watchers costs zero RPC traffic. The renderer
 * pre-filters batches against the declared patterns; this side still
 * re-checks every delivered event (grouped by anchor folder, so the relative
 * path is computed once per anchor and event rather than once per watcher).
 */
import {
  Emitter,
  URI,
  getPathComparisonKey,
  normalizePlatform,
  relativePathUnder,
  type HostPlatform,
  type IDisposable,
} from '@universe-editor/platform'
import type { GlobPattern, UriComponents } from '@universe-editor/extension-api'
import { compileGlobMatcher, splitAbsoluteGlob } from '@universe-editor/extensions-common'
import type {
  IFileChangeEventDto,
  IFileWatcherInterestDto,
  IMainThreadFileEvents,
} from '@universe-editor/extensions-common'
import type { FileSystemWatcherBridge } from './apiFactory.js'
import { InterestGate } from './interestGate.js'

interface WatcherEntry {
  readonly matches: (relPath: string) => boolean
  /** Key of this entry's anchor group in `_byAnchor`; '' groups the unanchored
   *  entries (no workspace folder, no base) which never match an event. */
  readonly anchorKey: string
  /** Reference on this entry's `{base, pattern}` interest; disposed with the watcher. */
  readonly interestLease: IDisposable
  readonly ignoreCreateEvents: boolean
  readonly ignoreChangeEvents: boolean
  readonly ignoreDeleteEvents: boolean
  readonly onDidCreate: Emitter<UriComponents>
  readonly onDidChange: Emitter<UriComponents>
  readonly onDidDelete: Emitter<UriComponents>
}

interface AnchorGroup {
  /** fsPath events are made relative to; undefined anchors match nothing. */
  readonly anchor: string | undefined
  readonly entries: Set<WatcherEntry>
}

export class HostFileWatcherRegistry {
  private readonly _entries = new Set<WatcherEntry>()
  private readonly _byAnchor = new Map<string, AnchorGroup>()
  private readonly _interestGate: InterestGate<IFileWatcherInterestDto>
  private readonly _platform: HostPlatform = normalizePlatform(process.platform)

  constructor(
    private readonly _mainThread: IMainThreadFileEvents,
    private readonly _workspaceRoot: string | undefined,
  ) {
    this._interestGate = new InterestGate<IFileWatcherInterestDto>(
      (dto) => this._mainThread.$subscribeFileEvents(dto),
      (dto) => this._mainThread.$unsubscribeFileEvents(dto),
      'file-events',
    )
  }

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
    const anchor = base ?? this._workspaceRoot
    const interestKey = `${base === undefined ? '' : getPathComparisonKey(base, this._platform)}\n${pattern}`
    const interestDto: IFileWatcherInterestDto = {
      base: base === undefined ? undefined : URI.file(base).toJSON(),
      pattern,
    }
    const entry: WatcherEntry = {
      matches: compileGlobMatcher(pattern),
      anchorKey: anchor === undefined ? '' : getPathComparisonKey(anchor, this._platform),
      interestLease: this._interestGate.acquire(interestKey, interestDto),
      ignoreCreateEvents,
      ignoreChangeEvents,
      ignoreDeleteEvents,
      onDidCreate: new Emitter<UriComponents>(),
      onDidChange: new Emitter<UriComponents>(),
      onDidDelete: new Emitter<UriComponents>(),
    }
    this._entries.add(entry)
    let group = this._byAnchor.get(entry.anchorKey)
    if (group === undefined) {
      group = { anchor, entries: new Set() }
      this._byAnchor.set(entry.anchorKey, group)
    }
    group.entries.add(entry)
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
        const group = this._byAnchor.get(entry.anchorKey)
        if (group !== undefined) {
          group.entries.delete(entry)
          if (group.entries.size === 0) this._byAnchor.delete(entry.anchorKey)
        }
        entry.interestLease.dispose()
      },
    }
  }

  /** IExtHostFileEvents.$acceptFileEvents */
  acceptFileEvents(events: readonly IFileChangeEventDto[]): void {
    if (this._entries.size === 0 || events.length === 0) return
    const platform = this._platform
    for (const event of events) {
      const revived = URI.revive(event.uri)
      // Watcher matching is host-local fsPath space: a non-`file:` resource has no
      // host-local path (its `.fsPath` would fold the authority into a bogus path).
      if (!revived || revived.scheme !== 'file') continue
      const fsPath = revived.fsPath
      for (const group of this._byAnchor.values()) {
        if (group.anchor === undefined) continue
        const rel = relativePathUnder(group.anchor, fsPath, platform)
        if (rel === null || rel === '') continue
        for (const entry of group.entries) {
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
  }

  dispose(): void {
    for (const entry of this._entries) {
      entry.onDidCreate.dispose()
      entry.onDidChange.dispose()
      entry.onDidDelete.dispose()
    }
    this._entries.clear()
    this._byAnchor.clear()
    // Drop every lease outright — reference counts are moot once the registry
    // itself is gone, and each unique interest still owes exactly one unsubscribe.
    this._interestGate.dispose()
  }
}
