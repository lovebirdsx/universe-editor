/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MainThreadFileEvents — the renderer end of the file-events pair backing
 *  `workspace.createFileSystemWatcher`. It reuses the workbench's existing
 *  recursive workspace watch (IFileWatcherService) instead of arming a native
 *  watcher per extension watcher.
 *
 *  The host declares each unique `(base, pattern)` interest exactly once
 *  (0↔n reference-counted on its side); this stage keeps the declared set and
 *  pre-filters every `onDidChangeFiles` batch against it — an event no live
 *  watcher could match never crosses the RPC (the host re-checks what it
 *  receives). Filtering groups matchers by anchor folder so the relative path
 *  is computed once per anchor and event.
 *
 *  A watcher anchored outside the workspace (RelativePattern base, or the
 *  literal root of an absolute glob) isn't covered by the workspace watch, so
 *  each such base is reference-counted here and armed via
 *  `addOutOfWorkspaceFolder`; its events flow through the same
 *  `onDidChangeFiles` → `$acceptFileEvents` pipeline. A pattern that anchors
 *  exactly one file (a slash-containing literal, e.g. 'cfg/app.txt') arms a
 *  cheap non-recursive file watch instead of the whole tree (slashless
 *  literals still match at any depth, so those keep the recursive watch).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  URI,
  type IDisposable,
  type IFileChangeEvent,
  type IFileWatcherService,
  type ILogger,
  type IUriIdentityService,
  type UriComponents,
} from '@universe-editor/platform'
import {
  compileGlobMatcher,
  type IFileChangeEventDto,
  type IExtHostFileEvents,
  type IFileWatcherInterestDto,
  type IMainThreadFileEvents,
} from '@universe-editor/extensions-common'
import { IOutOfWorkspaceWatchService } from '../files/outOfWorkspaceWatchService.js'

/** Batch cap so a mass change (branch switch, build clean) can't flood the
 *  newline-JSON RPC — this repo has an RPC-flood OOM history. */
const MAX_EVENTS_PER_BATCH = 5000

const HAS_GLOB_CHARS = /[*?{[]/

/** A slash-containing literal pattern pins exactly one file under its base —
 *  a directory-level non-recursive watch covers it. Slashless literals match
 *  the basename at any depth and globs keep the recursive folder watch. */
function anchorsSingleFile(pattern: string): boolean {
  if (HAS_GLOB_CHARS.test(pattern)) return false
  return pattern.replace(/\\/g, '/').replace(/^\/+/, '').includes('/')
}

function reviveFileUri(base: UriComponents): URI | undefined {
  const uri = URI.revive(base)
  if (!(uri instanceof URI) || uri.scheme !== 'file') return undefined
  return uri
}

interface InterestEntry {
  readonly matches: (relPath: string) => boolean
  readonly base: URI | undefined
}

export class MainThreadFileEvents extends Disposable implements IMainThreadFileEvents {
  private readonly _interests = new Map<string, InterestEntry>()
  /** Out-of-workspace base folders, shared across patterns and reference-counted. */
  private readonly _folderWatches = new Map<string, { uri: URI; count: number }>()
  /** File-level interests (per unique `(base, pattern)`), via the multi-consumer watch service. */
  private readonly _fileWatchHandles = new Map<string, IDisposable>()

  constructor(
    private readonly _watcher: IFileWatcherService,
    private readonly _extHost: IExtHostFileEvents,
    private readonly _logger: ILogger,
    private readonly _uriIdentity: IUriIdentityService,
    private readonly _outOfWorkspaceWatch: IOutOfWorkspaceWatchService,
    private readonly _workspaceRoot: string | undefined,
  ) {
    super()
    this._register(this._watcher.onDidChangeFiles((events) => this._forward(events)))
  }

  $subscribeFileEvents(interest: IFileWatcherInterestDto): Promise<void> {
    const base = interest.base === undefined ? undefined : reviveFileUri(interest.base)
    if (interest.base !== undefined && base === undefined) {
      this._logger.warn('file-events subscription with a non-file base ignored')
      return Promise.resolve()
    }
    const key = this._interestKey(base, interest.pattern)
    if (this._interests.has(key)) {
      // The host 0↔n-counts interests, so a duplicate subscribe means the two
      // sides drifted apart — keep counting on the host's terms but stay sane.
      this._logger.warn(`duplicate file-events subscription: ${interest.pattern}`)
      return Promise.resolve()
    }
    this._interests.set(key, { matches: compileGlobMatcher(interest.pattern), base })
    if (base !== undefined) {
      if (anchorsSingleFile(interest.pattern)) {
        const segments = interest.pattern.replace(/\\/g, '/').replace(/^\/+/, '').split('/')
        const fileUri = URI.joinPath(base, ...segments)
        this._fileWatchHandles.set(key, this._outOfWorkspaceWatch.watch([fileUri]))
      } else {
        const baseKey = this._uriIdentity.getComparisonKey(base)
        const folder = this._folderWatches.get(baseKey)
        if (folder !== undefined) {
          folder.count++
        } else {
          this._folderWatches.set(baseKey, { uri: base, count: 1 })
          void this._watcher.addOutOfWorkspaceFolder(base).catch((err: unknown) => {
            this._logger.warn(`out-of-workspace watch failed: ${(err as Error).message}`)
          })
        }
      }
    }
    return Promise.resolve()
  }

  $unsubscribeFileEvents(interest: IFileWatcherInterestDto): Promise<void> {
    const base = interest.base === undefined ? undefined : reviveFileUri(interest.base)
    const key = this._interestKey(base, interest.pattern)
    if (!this._interests.delete(key)) return Promise.resolve()
    if (base !== undefined) {
      const fileHandle = this._fileWatchHandles.get(key)
      if (fileHandle !== undefined) {
        this._fileWatchHandles.delete(key)
        fileHandle.dispose()
      } else {
        const baseKey = this._uriIdentity.getComparisonKey(base)
        const folder = this._folderWatches.get(baseKey)
        if (folder !== undefined) {
          folder.count--
          if (folder.count <= 0) {
            this._folderWatches.delete(baseKey)
            void this._watcher.removeOutOfWorkspaceFolder(folder.uri).catch((err: unknown) => {
              this._logger.warn(`out-of-workspace unwatch failed: ${(err as Error).message}`)
            })
          }
        }
      }
    }
    return Promise.resolve()
  }

  override dispose(): void {
    for (const handle of this._fileWatchHandles.values()) {
      handle.dispose()
    }
    this._fileWatchHandles.clear()
    if (this._folderWatches.size > 0) {
      this._folderWatches.clear()
      // The connection is going away; release every armed folder watch.
      void this._watcher.clearOutOfWorkspaceFolders().catch((err: unknown) => {
        this._logger.warn(`clearing out-of-workspace watches failed: ${(err as Error).message}`)
      })
    }
    super.dispose()
  }

  private _interestKey(base: URI | undefined, pattern: string): string {
    return `${base === undefined ? '' : this._uriIdentity.getComparisonKey(base)}\n${pattern}`
  }

  private _forward(events: readonly IFileChangeEvent[]): void {
    if (this._interests.size === 0 || events.length === 0) return
    // Group matchers by anchor folder so each event's relative path is
    // computed once per anchor, not once per watcher. The folded key merges
    // different spellings of the same folder into one group.
    const groups = new Map<
      string,
      { anchor: string | undefined; matchers: ((rel: string) => boolean)[] }
    >()
    for (const entry of this._interests.values()) {
      // 本机路径：anchor 来自 `reviveFileUri` 过滤后的 file: URI（或本地 workspaceRoot 字符串）。
      const anchor = entry.base?.fsPath ?? this._workspaceRoot
      const anchorKey = anchor === undefined ? '' : this._uriIdentity.getPathComparisonKey(anchor)
      let group = groups.get(anchorKey)
      if (group === undefined) {
        group = { anchor, matchers: [] }
        groups.set(anchorKey, group)
      }
      group.matchers.push(entry.matches)
    }
    const kept: IFileChangeEvent[] = []
    let dropped = 0
    for (const event of events) {
      // 本机路径：工作区 watch 产出的 file: 资源事件，fsPath 即本机路径。
      const fsPath = event.resource.fsPath
      let include = false
      for (const group of groups.values()) {
        if (group.anchor === undefined) continue
        const rel = this._uriIdentity.relativePathUnder(group.anchor, fsPath)
        if (rel === null || rel === '') continue
        if (group.matchers.some((matches) => matches(rel))) {
          include = true
          break
        }
      }
      if (include) kept.push(event)
      else dropped++
    }
    if (kept.length === 0) return
    if (dropped > 0) {
      this._logger.debug(`file events pre-filtered: kept=${kept.length} dropped=${dropped}`)
    }
    let batch = kept
    if (kept.length > MAX_EVENTS_PER_BATCH) {
      this._logger.warn(`file events batch truncated: ${kept.length} → ${MAX_EVENTS_PER_BATCH}`)
      batch = kept.slice(0, MAX_EVENTS_PER_BATCH)
    }
    const dtos: IFileChangeEventDto[] = batch.map((e) => ({
      type: e.type === 'added' ? 'created' : e.type === 'deleted' ? 'deleted' : 'changed',
      uri: e.resource.toJSON(),
    }))
    void this._extHost.$acceptFileEvents(dtos).catch((err: unknown) => {
      this._logger.warn(`file events push failed: ${(err as Error).message}`)
    })
  }
}
