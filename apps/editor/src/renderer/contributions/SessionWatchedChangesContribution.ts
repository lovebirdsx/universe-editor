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
 *      → stat confirm (a 'deleted' event is frequently an atomic rewrite;
 *        directories are skipped)
 *      → pre-change content from the owning SCM provider's getHeadContent
 *        command (git HEAD ≈ the pre-turn state; null = no HEAD revision,
 *        i.e. the file is new) → tracker.recordWatched
 *
 *  Editor-originated saves are excluded via the self-write registry so a user
 *  saving a file mid-turn is not misattributed to the agent. Watched entries
 *  render with an "inferred" badge and a per-row dismiss in SessionChangesView.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ICommandService,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  IUriIdentityService,
  NullLogger,
  type IFileChangeEvent,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
  type URI,
} from '@universe-editor/platform'
import { dirtyDiffCommandId } from '@universe-editor/extensions-common'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { ISessionChangeTrackerService } from '../services/acp/session/sessionChangeTracker.js'
import { IScmService, resolveScmProviderId } from '../services/extensions/ScmService.js'
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
  ) {
    super()
    this._logger =
      loggerService?.createLogger({
        id: 'sessionWatchedChanges',
        name: 'Session Watched Changes',
      }) ?? new NullLogger()
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
    for (const [key, entry] of entries) {
      try {
        await this._processEntry(key, entry)
      } catch (err) {
        this._logger.warn(`watched change failed for ${entry.uri.toString()}`, err)
      }
    }
  }

  private async _processEntry(key: string, entry: PendingChange): Promise<void> {
    // Confirm what's actually on disk: a 'deleted' event is often an atomic
    // rewrite, and directory events carry no diffable content.
    try {
      const stat = await this._files.stat(entry.uri)
      if (!stat.isFile) return
    } catch {
      // Truly gone — still recorded: with a git baseline the row shows as
      // deleted; without one a created-then-deleted file nets out to nothing.
    }

    // A single baseline lookup serves every session that saw the change.
    let baselineFetched = false
    let baselineOpts: { readonly baseline: string | null } | undefined

    for (const sid of entry.sessionIds) {
      const tracked = this._tracker
        .changesFor(sid)
        .get()
        .some((c) => this._uriIdentity.getComparisonKey(c.uri) === key)
      if (tracked) {
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
