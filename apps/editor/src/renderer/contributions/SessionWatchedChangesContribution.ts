/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionWatchedChangesContribution — fs-watch fallback for the session diff.
 *
 *  Agent tool calls report their file edits (the tracker's authoritative
 *  ingress), but shell/terminal writes never do — a `sed -i` or `git apply`
 *  run by the agent is invisible to the session diff. This contribution
 *  subscribes to the workspace file watcher and, while any session's turn is
 *  running, records untracked changes as *inferred* ("watched") entries:
 *
 *    watcher batch → tag with the sessions running at event time
 *      → grace delay (lets the agent's own tool-call report land first,
 *        turning the flush into a cheap refresh for reported edits)
 *      → drop ignored paths (the owning provider's checkIgnore ∪ the built-in
 *        Perforce rules — see _ignoredPaths)
 *      → stat confirm (a 'deleted' event is frequently an atomic rewrite;
 *        directories are skipped)
 *      → binary gate (a build's compiled artifacts cost one 512-byte head read
 *        and never become tracked entries)
 *      → pre-change content from the owning SCM provider's getHeadContent
 *        command (git HEAD ≈ the pre-turn state; null = no HEAD revision,
 *        i.e. the file is new) → tracker.recordWatched
 *
 *  Editor-originated saves are excluded via the self-write registry so a user
 *  saving a file mid-turn is not misattributed to the agent. App-owned paths
 *  (userData state/logs, packaged resources like the bundled theme JSONs the
 *  theme service watches) are excluded via a blacklist — everything else,
 *  including files outside the workspace the agent wrote via shell, is kept.
 *  Watched entries render with an "inferred" badge and a per-row dismiss in
 *  SessionChangesView.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ICommandService,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  IUriIdentityService,
  NullLogger,
  URI,
  type IFileChangeEvent,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { dirtyDiffCommandId } from '@universe-editor/extensions-common'
import { IEnvironmentSnapshotService } from '../../shared/ipc/environmentSnapshotService.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { ISessionChangeTrackerService } from '../services/acp/session/sessionChangeTracker.js'
import { IScmService, resolveScmProviderId } from '../services/extensions/ScmService.js'
import { probeIsBinary } from '../services/files/binaryDetection.js'
import { IP4IgnoreService } from '../services/scm/P4IgnoreService.js'
import { scmViewState } from '../workbench/scm/scmViewState.js'
import { recentSelfWrites } from '../services/editor/selfWriteRegistry.js'

/** Grace before processing a batch: the agent's own Edit/Write report for the
 *  same path usually arrives within ~100ms of the disk write; waiting turns the
 *  common case into a no-op refresh instead of a spurious watched entry. */
const FLUSH_DELAY_MS = 1500

/** How long an editor self-write shields its path from being flagged. */
const SELF_WRITE_WINDOW_MS = 3000

/** Cap per flush — a shell command rewriting a whole tree must not turn the
 *  session diff into a thousand-row guess list (nor fire N git commands). */
const MAX_PATHS_PER_FLUSH = 50

interface PendingChange {
  readonly uri: URI
  readonly sessionIds: Set<string>
}

export class SessionWatchedChangesContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _logger: ILogger
  /** comparison-key → pending change, accumulated until the flush timer fires. */
  private readonly _pending = new Map<string, PendingChange>()
  private _flushTimer: ReturnType<typeof setTimeout> | undefined
  private _droppedSinceFlush = 0
  /** App-owned roots whose file events are never session edits. */
  private _appOwnedRoots: readonly URI[] = []

  /** Grace window between a watcher batch and its processing. Test override. */
  flushDelayMs = FLUSH_DELAY_MS

  constructor(
    @IFileWatcherService watcher: IFileWatcherService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @ISessionChangeTrackerService private readonly _tracker: ISessionChangeTrackerService,
    @IScmService private readonly _scm: IScmService,
    @ICommandService private readonly _commands: ICommandService,
    @IFileService private readonly _files: IFileService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @ILoggerService loggerService: ILoggerServiceType,
    @IEnvironmentSnapshotService envSnapshot: IEnvironmentSnapshotService,
    @IP4IgnoreService private readonly _p4Ignore: IP4IgnoreService,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({
        id: 'sessionWatchedChanges',
        name: 'Session Watched Changes',
      }) ?? new NullLogger()
    void envSnapshot
      .getSnapshot()
      .then((s) => {
        const roots = [URI.file(s.userDataDir)]
        if (s.appResourcesPath !== undefined) roots.push(URI.file(s.appResourcesPath))
        this._appOwnedRoots = roots
      })
      .catch((err) => this._logger.warn('failed to resolve app-owned roots', err))
    this._register(watcher.onDidChangeFiles((events) => this._collect(events)))
  }

  override dispose(): void {
    if (this._flushTimer !== undefined) clearTimeout(this._flushTimer)
    super.dispose()
  }

  private _runningSessionIds(): string[] {
    const ids: string[] = []
    for (const session of this._sessions.sessions.get()) {
      if (session.status.get() !== 'running') continue
      const sid = session.sessionIdOnAgent.get()
      if (sid !== undefined) ids.push(sid)
    }
    return ids
  }

  private _collect(events: readonly IFileChangeEvent[]): void {
    // Eligibility is captured at event time: a change during a running turn is
    // attributed to that turn even if it ends before the flush fires.
    const running = this._runningSessionIds()
    if (running.length === 0) return
    const selfKeys = new Set(
      recentSelfWrites(SELF_WRITE_WINDOW_MS).map((u) => this._uriIdentity.getComparisonKey(u)),
    )
    for (const ev of events) {
      if (ev.resource.scheme !== 'file') continue
      // App-owned files (userData state/logs, packaged resources such as the
      // bundled theme JSONs the theme service watches) fire on the same global
      // watcher but can never belong to a session diff. Dropping them here also
      // keeps them out of the MAX_PATHS_PER_FLUSH budget. Everything else —
      // workspace or not — is kept: agents legitimately write outside the
      // workspace via shell (plan files, ~/.claude, explore results).
      if (
        this._appOwnedRoots.some((root) => this._uriIdentity.isEqualOrParent(ev.resource, root))
      ) {
        continue
      }
      const key = this._uriIdentity.getComparisonKey(ev.resource)
      if (selfKeys.has(key)) continue
      let entry = this._pending.get(key)
      if (!entry) {
        if (this._pending.size >= MAX_PATHS_PER_FLUSH) {
          this._droppedSinceFlush++
          continue
        }
        entry = { uri: ev.resource, sessionIds: new Set() }
        this._pending.set(key, entry)
      }
      for (const sid of running) entry.sessionIds.add(sid)
    }
    if (this._pending.size > 0 && this._flushTimer === undefined) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = undefined
        void this._flush()
      }, this.flushDelayMs)
    }
  }

  private async _flush(): Promise<void> {
    const entries = [...this._pending.entries()]
    this._pending.clear()
    if (this._droppedSinceFlush > 0) {
      this._logger.warn(
        `watched-change storm: dropped ${this._droppedSinceFlush} paths beyond the ${MAX_PATHS_PER_FLUSH}-path cap`,
      )
      this._droppedSinceFlush = 0
    }
    const ignored = await this._ignoredPaths(entries.map(([, entry]) => entry.uri.fsPath))
    for (const [, entry] of entries) {
      if (ignored.has(entry.uri.fsPath)) continue
      try {
        await this._processEntry(entry)
      } catch (err) {
        this._logger.warn(`watched change failed for ${entry.uri.toString()}`, err)
      }
    }
  }

  /**
   * Batch check-ignore over the flush's paths: ignored files (build caches like
   * `.eslintcache`) have no HEAD revision, so without this they'd all surface as
   * spurious "created" rows. Best-effort — an unregistered command or a failed
   * call degrades to no filtering rather than breaking the fallback chain.
   *
   * The provider's answer is unioned with the built-in Perforce rules, not
   * substituted by them: `checkIgnore` returns an empty array both when nothing
   * is ignored and when the provider is offline, unactivated, or not yet
   * registered — three states where only the local rules can answer. Both
   * sources run concurrently (the command times out after 20s, so serializing
   * them would stall the flush).
   */
  private async _ignoredPaths(fsPaths: readonly string[]): Promise<ReadonlySet<string>> {
    const [delegated, builtIn] = await Promise.all([
      this._providerIgnoredPaths(fsPaths),
      // The built-in resolver documents "never rejects", but the union must not
      // hinge on another service's promise: an empty set degrades to the
      // provider's answer alone.
      this._p4Ignore.resolveIgnored(fsPaths).catch((err: unknown) => {
        this._logger.warn('built-in Perforce ignore lookup failed; using the provider only', err)
        return new Set<string>()
      }),
    ])
    const ignored = new Set(delegated)
    for (const p of builtIn) ignored.add(p)
    if (ignored.size > 0) {
      this._logger.debug(`dropping ${ignored.size} ignored watched-change path(s)`)
    }
    return ignored
  }

  private async _providerIgnoredPaths(fsPaths: readonly string[]): Promise<ReadonlySet<string>> {
    const byProvider = new Map<string, string[]>()
    for (const fsPath of fsPaths) {
      const providerId = resolveScmProviderId(
        this._scm.sourceControls.get(),
        fsPath,
        scmViewState.selectedRepo.get(),
      )
      if (providerId === undefined) continue
      const list = byProvider.get(providerId)
      if (list) list.push(fsPath)
      else byProvider.set(providerId, [fsPath])
    }
    const ignored = new Set<string>()
    for (const [providerId, paths] of byProvider) {
      try {
        const res = await this._commands.executeCommand<readonly string[] | undefined>(
          dirtyDiffCommandId(providerId, 'checkIgnore'),
          paths,
        )
        // undefined = command not registered (extension still activating).
        if (res === undefined) continue
        for (const p of res) ignored.add(p)
      } catch (err) {
        this._logger.warn(`check-ignore via ${providerId} failed; keeping batch unfiltered`, err)
      }
    }
    return ignored
  }

  private async _processEntry(entry: PendingChange): Promise<void> {
    // Confirm what's actually on disk: a 'deleted' event is often an atomic
    // rewrite, and directory events carry no diffable content.
    try {
      const stat = await this._files.stat(entry.uri)
      if (!stat.isFile) return
    } catch {
      // Truly gone — still recorded: the tracker's self-heal rules net it out
      // (created-then-deleted, or a watched no-baseline entry whose file vanished).
    }

    // Compiled intermediate artifacts are the dominant source of watcher noise
    // during a build, and one of them must never become a tracked change: the
    // tracker reads tracked files whole, and a 16MB binary crossing that path
    // once took a renderer down. Answered first, so a binary costs a 512-byte
    // head read and nothing more — in particular no baseline lookup.
    const binary = await probeIsBinary(this._files, entry.uri)
    if (binary === true) {
      this._logger.debug(`dropping binary watched change ${entry.uri.fsPath}`)
      for (const sid of entry.sessionIds) {
        // Still refresh any session that already tracks the path — an earlier
        // pass may have seen a text file before the artifact overwrote it — so
        // the tracker gets to clear that row.
        if (this._tracker.hasEntry(sid, entry.uri.fsPath)) {
          this._tracker.recordWatched(sid, entry.uri.fsPath)
        }
      }
      return
    }
    if (binary === undefined) {
      // Fail open, like every other failure in this chain: losing a real change
      // is worse than tracking one, and the tracker's own read caps bound it.
      this._logger.debug(`binary probe failed for ${entry.uri.fsPath}; keeping the change`)
    }

    // A single baseline lookup serves every session that saw the change.
    let baselineFetched = false
    let baselineOpts: { readonly baseline: string | null } | undefined

    for (const sid of entry.sessionIds) {
      if (this._tracker.hasEntry(sid, entry.uri.fsPath)) {
        // Already in the session diff — recordWatched only refreshes it.
        this._tracker.recordWatched(sid, entry.uri.fsPath)
        continue
      }
      if (!baselineFetched) {
        baselineFetched = true
        baselineOpts = await this._gitBaseline(entry.uri.fsPath)
      }
      this._logger.debug(
        `recording watched change ${entry.uri.fsPath} for session ${sid} (baseline: ${
          baselineOpts === undefined
            ? 'unavailable'
            : baselineOpts.baseline === null
              ? 'created'
              : 'git'
        })`,
      )
      if (baselineOpts === undefined) this._tracker.recordWatched(sid, entry.uri.fsPath)
      else this._tracker.recordWatched(sid, entry.uri.fsPath, baselineOpts)
    }
  }

  /**
   * Pre-change content from the owning SCM provider (git HEAD). Returns
   * undefined when no provider owns the path or the command is unavailable
   * (entry degrades to "known changed, not comparable"); `baseline: null` when
   * the file has no HEAD revision, i.e. it did not exist before the turn.
   */
  private async _gitBaseline(
    fsPath: string,
  ): Promise<{ readonly baseline: string | null } | undefined> {
    const providerId = resolveScmProviderId(
      this._scm.sourceControls.get(),
      fsPath,
      scmViewState.selectedRepo.get(),
    )
    if (providerId === undefined) return undefined
    try {
      const head = await this._commands.executeCommand<string | null>(
        dirtyDiffCommandId(providerId, 'getHeadContent'),
        fsPath,
      )
      // undefined = command not registered (extension still activating).
      if (head === undefined) return undefined
      return { baseline: head }
    } catch {
      return undefined
    }
  }
}
