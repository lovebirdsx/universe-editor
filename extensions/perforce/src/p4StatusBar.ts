/**
 * The Perforce status-bar entries: the main client name + connection state item,
 * plus a revision chip (`#have / #head`) for the active editor's file. All
 * render whichever client is active — switching the SCM selection re-points
 * them, mirroring VSCode's single-repo status bar (and git's
 * GitStatusBarController). Clicking the main item opens the Perforce graph; the
 * revision chip syncs just the file it describes.
 *
 * The revision chip re-reads the active editor on every tab switch
 * (`onDidChangeActiveTextEditor`) and routes the file through
 * `ClientManager.resolveContaining` (NO active-client fallback — a data query,
 * not a command route, so a file outside every client root must not read the
 * active client's fstat). The fstat itself goes through the BaselineProvider's
 * short-TTL cache + negative-result sentinel, so tab-switch bursts collapse
 * into at most one server round-trip per file per 15s.
 *
 * In a mixed workspace (a git repo nested in a p4 client, say) the renderer
 * pushes `perforce.setActiveRepo` without arguments (or with null, via the
 * nested-args RPC convention) when the selection moves to another provider's
 * repo; `setVisible(false)` hides both items and every render short-circuits
 * until a p4 client is selected again.
 */
import {
  window,
  StatusBarAlignment,
  type Disposable,
  type StatusBarItem,
  type TextEditor,
} from '@universe-editor/extension-api'
import type { ClientManager } from './clientManager.js'
import { uriToFsPath } from './pathUtil.js'
import { asRev, type FstatInfo } from './fstatParser.js'
import { formatBytes, formatIoRate, RateWindow } from './processIo.js'
import { localize } from './nls.js'
import type { PerforceClient, SyncProgress } from './client.js'

/** Truncate a long client name for the busy status-bar text: keep at most `max`
 *  chars of the tail, but never slice mid-word — when the cut lands inside a
 *  `_`-separated segment, extend forward to the next `_` (only if that leaves at
 *  least 4 informative chars, else keep the hard cut). */
export function truncateClientName(name: string, max = 10): string {
  if (name.length <= max) return name
  let tail = name.slice(-max)
  const before = name[name.length - max - 1]
  if (before !== '_' && tail[0] !== '_') {
    const idx = tail.indexOf('_')
    if (idx !== -1 && tail.length - idx - 1 >= 4) tail = tail.slice(idx + 1)
  }
  if (tail[0] === '_') tail = tail.slice(1)
  return `…${tail}`
}

/** Format a scan's elapsed wall-clock time (milliseconds) as a compact
 *  `12s` / `1m 12s` readout. */
export function formatScanElapsed(elapsedMs: number): string {
  const total = Math.floor(elapsedMs / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m ${s}s`
}

/** The human name of a sync's target, for the status-bar tooltip. `spec` is the
 *  raw revision suffix {@link PerforceClient.sync} was called with, or `''` for
 *  the per-file force get (each filespec then carries its own `#rev`).
 *
 *  The raw spec is what the run actually pulls, so an unrecognized form passes
 *  through verbatim rather than being dressed up: `#4` is already the clearest
 *  name for itself, and inventing one would risk naming a revision the run isn't
 *  fetching. */
export function syncTargetLabel(spec: string): string {
  // `=== ''` first, and identity-based: the empty spec is a REAL value (the
  // per-file get) that happens to be falsy — a truthiness test would mislabel it.
  if (spec === '') return localize('perforce.status.syncTargetPicked', 'the selected files')
  // Case-insensitive: the revision prompt passes what the user typed through, so
  // `#HEAD` reaches here as readily as `#head` and names the same thing.
  if (spec.toLowerCase() === '#head') {
    return localize('perforce.status.syncTargetHead', 'the latest revision')
  }
  const changelist = /^@(\d+)$/.exec(spec)?.[1]
  if (changelist !== undefined) {
    return localize('perforce.status.syncTargetChangelist', 'changelist {0}', { 0: changelist })
  }
  return spec
}

export class P4StatusBarController {
  private readonly _item: StatusBarItem
  private readonly _revItem: StatusBarItem
  private _clientSub: Disposable | undefined
  private _editorSub: Disposable | undefined
  /** Generation guard so a slow fstat can't paint over a newer editor's chip. */
  private _revToken = 0
  /** Hidden by `setVisible(false)` while the SCM selection points at another
   *  provider; every render short-circuits so nothing can re-show the items. */
  private _visible = true
  /** 1s ticker that re-renders while a sync is in flight. The elapsed clock is
   *  computed at render time (`Date.now() - startedAt`), so without it the count
   *  AND the clock both freeze for the whole gap between p4's stdout bursts —
   *  which under `--parallel` can be a minute or more. */
  private _syncHeartbeat: ReturnType<typeof setInterval> | undefined
  /** I/O-rate window (read + write) for the sync body, sampled at RENDER time
   *  (see {@link _syncRateText}) — same idiom as the elapsed clock: a pure
   *  repaint can move the number, so no new client event is needed to make it
   *  decay. */
  private readonly _syncRate = new RateWindow()
  /** Which sync run {@link _syncRate} belongs to; a new run resets it. */
  private _syncRateRun: number | undefined
  /** Which client {@link _syncRate} was measured on (see {@link refresh}). */
  private _syncRateOwner: PerforceClient | undefined

  constructor(private readonly _mgr: ClientManager) {
    this._item = window.createStatusBarItem(StatusBarAlignment.Left, 100)
    this._item.command = 'perforce-graph.view'
    // Lower priority sits left of the main item: `#have / #head` for the active
    // editor's file, its own signal next to (not merged into) the main item.
    this._revItem = window.createStatusBarItem(StatusBarAlignment.Left, 80)
    this._editorSub = window.onDidChangeActiveTextEditor((editor) => this._renderRev(editor))
    this._renderRev()
  }

  /** Re-point at the active client and re-render. Call after the active client
   *  changes or a new client is added. */
  refresh(): void {
    const client = this._mgr.active
    // The window belongs to one client's run: a re-point at another workspace
    // must not difference the new client's totals against the old one's. Scoped
    // to an actual change of client — a plain re-render (the SCM selection came
    // back to this repo) must keep the live window, or the body blinks to
    // `000KB/s` for a frame while a sync is running.
    if (this._syncRateOwner !== client) {
      this._syncRateOwner = client
      this._dropSyncRate()
    }
    this._clientSub?.dispose()
    this._clientSub = client?.onDidChange(() => {
      this._render()
      // A refresh invalidates the fstat cache after mutations, so re-read the
      // chip too — that's what picks up a new haveRev after a sync. The cached
      // fstat absorbs the busy push/pop bursts.
      this._renderRev()
    })
    this._render()
    this._renderRev()
  }

  /** Show or hide both items. `false` is pushed via `perforce.setActiveRepo`
   *  when the SCM selection moved to another provider's repo; `true` restores
   *  and re-renders from the active client. */
  setVisible(visible: boolean): void {
    this._visible = visible
    if (!visible) {
      this._item.hide()
      this._revItem.hide()
      return
    }
    this.refresh()
  }

  /** Arm or stop the sync heartbeat. Armed exactly while a streaming sync is
   *  showing: each tick re-renders so the elapsed clock advances even when p4
   *  hasn't printed a line in a while. This is a pure repaint — the client's
   *  data is unchanged, only the render-time `Date.now() - startedAt` moves —
   *  so it lives here, not in the client's `_emitChange` (which means "state
   *  changed"). */
  private _setSyncHeartbeat(active: boolean): void {
    if (active && this._syncHeartbeat === undefined) {
      this._syncHeartbeat = setInterval(() => this._render(), 1000)
    } else if (!active && this._syncHeartbeat !== undefined) {
      clearInterval(this._syncHeartbeat)
      this._syncHeartbeat = undefined
    }
  }

  /** The p4 process I/O rate for the sync body — READ + WRITE — or undefined
   *  when this run has no sampler (the body then falls back to the watcher count).
   *
   *  Both sides, because they move in different phases: reads climb while p4
   *  pulls from the server, writes while it lands the files in the workspace. A
   *  read-only rate decays to `000KB/s` in that second phase — the bar then reads
   *  as stalled exactly while the disk is being written, the false signal this
   *  readout exists to remove. The token is a sum, so it stays alive while either
   *  side moves; the tooltip still reports the split.
   *
   *  Computed here rather than in the client because it is a function of `now`:
   *  pushing the current cumulative byte count on every render is what lets the
   *  window slide off a stalled transfer and decay to `000KB/s` from the 1s
   *  heartbeat alone, with no further events from p4. */
  private _syncRateText(progress: SyncProgress): string | undefined {
    const read = progress.ioReadBytes
    if (read === undefined) {
      this._dropSyncRate()
      return undefined
    }
    if (this._syncRateRun !== progress.startedAt) {
      this._syncRateRun = progress.startedAt
      this._syncRate.reset()
    }
    const now = Date.now()
    // Both sides are published together (see `_setSyncProgress`), so the `?? 0`
    // only covers a hand-built DTO. The sum is monotone as long as either side
    // is, so the window's difference still measures a rate.
    this._syncRate.push(now, read + (progress.ioWriteBytes ?? 0))
    // One sample has no span to difference over yet. That is a real zero — the
    // run just started with a sampler attached — not "no rate at all", so the
    // token keeps its width instead of blinking out of the body.
    return formatIoRate(this._syncRate.rateAt(now) ?? 0)
  }

  private _dropSyncRate(): void {
    if (this._syncRateRun === undefined) return
    this._syncRateRun = undefined
    this._syncRate.reset()
  }

  private _render(): void {
    if (!this._visible) {
      this._setSyncHeartbeat(false)
      return
    }
    const client = this._mgr.active
    if (!client) {
      this._setSyncHeartbeat(false)
      this._item.hide()
      return
    }
    const {
      clientName,
      connection,
      openedCount,
      busy,
      busyCancellable,
      scanProgress,
      syncProgress,
      lastSyncSpec,
    } = client.status
    this._setSyncHeartbeat(syncProgress !== undefined)
    if (busy) {
      // A long-running p4 operation is in flight — show a spinner + its label so
      // the user sees the client isn't stalled (mirrors git's syncing indicator).
      // While it's cancellable, clicking cancels instead of opening the graph:
      // without this the only way out of a slow operation is to wait out
      // `perforce.commandTimeout`. The spinner is an inline `$(sync~spin)` so it
      // sits on the right — hence showProgress is cleared, else a lucide spinner
      // would also appear on the left and we'd get one on each side.
      this._item.showProgress = undefined
      const short = truncateClientName(clientName)
      if (syncProgress) {
        // No total is ever shown: the pre-flight count that would produce one
        // costs a full server-side walk on a wide scope, so a sync starts
        // downloading immediately instead. The bare count alone reads as
        // stalled, so the body pairs it with a live signal — under `--parallel`
        // p4's stdout goes quiet for minutes at a time, and even before that it
        // spends the first minutes server-side without touching a workspace file.
        // Two sources fill that, in this order: the p4 process's own read rate
        // when a sampler is attached (moves from the first server round-trip),
        // else the watcher-observed disk count (moves only once files land).
        const elapsed = formatScanElapsed(Date.now() - syncProgress.startedAt)
        const disk = syncProgress.diskWrites
        const rate = this._syncRateText(syncProgress)
        const middle =
          rate ??
          (disk !== undefined && disk > 0
            ? localize('perforce.status.syncDisk', 'disk +{0}', { 0: disk })
            : undefined)
        const count =
          middle !== undefined
            ? `${syncProgress.done} · ${middle} · ${elapsed}`
            : `${syncProgress.done} · ${elapsed}`
        this._item.text = `$(server) ${short}: ${busy} ${count} $(sync~spin)`
        const lines = [
          localize('perforce.status.syncing', 'Syncing {0}', { 0: clientName }),
          // Which revision this run is pulling, right under the title line: the
          // notification spells it out once and is gone, and "which changelist
          // did I just get?" is exactly what a tooltip is asked afterwards.
          ...(lastSyncSpec !== undefined
            ? [
                localize('perforce.status.syncTarget', 'Target: {0}', {
                  0: syncTargetLabel(lastSyncSpec),
                }),
              ]
            : []),
          localize('perforce.status.syncCounts', 'Synced {0} files', { 0: syncProgress.done }),
        ]
        if (syncProgress.ioReadBytes !== undefined) {
          lines.push(
            localize(
              'perforce.status.syncIoTooltip',
              'p4 process I/O: read {0}, wrote {1} (OS process counters — includes network receive and staged temporary files, so not a disk-write figure)',
              {
                0: formatBytes(syncProgress.ioReadBytes),
                1: formatBytes(syncProgress.ioWriteBytes ?? 0),
              },
            ),
          )
        }
        if (disk !== undefined && disk > 0) {
          lines.push(
            localize(
              'perforce.status.syncDiskTooltip',
              'Disk writes seen by the file watcher: {0} (approximate; the watcher batches and may truncate events)',
              { 0: disk },
            ),
          )
        }
        if (syncProgress.currentFile !== undefined) {
          lines.push(
            localize('perforce.status.syncCurrent', 'Current: {0}', {
              0: syncProgress.currentFile,
            }),
          )
        }
        lines.push(
          localize('perforce.status.syncElapsed', '{0} elapsed', {
            0: elapsed,
          }),
        )
        if (busyCancellable) {
          lines.push('', localize('perforce.status.clickToCancel', 'Click to cancel'))
          this._item.command = 'perforce.cancelBusy'
        } else {
          this._item.command = 'perforce-graph.view'
        }
        this._item.tooltip = lines.join('\n')
        this._item.show()
        return
      }
      if (scanProgress) {
        const total = scanProgress.done + scanProgress.pending
        this._item.text = `$(server) ${short}: ${scanProgress.done}/${total} $(sync~spin)`
        const lines = [
          localize('perforce.status.scanning', 'Scanning workspace {0}', { 0: clientName }),
          localize('perforce.status.scanCounts', 'Scanned {0} directories / {1} pending', {
            0: scanProgress.done,
            1: scanProgress.pending,
          }),
        ]
        if (scanProgress.currentDir !== undefined) {
          lines.push(
            scanProgress.currentDir === '.'
              ? localize('perforce.status.scanCurrentRoot', 'Current: workspace root')
              : localize('perforce.status.scanCurrent', 'Current: {0}', {
                  0: scanProgress.currentDir,
                }),
          )
        }
        lines.push(
          localize('perforce.status.scanDrift', 'Found {0} drift files · {1} elapsed', {
            0: scanProgress.driftFound,
            1: formatScanElapsed(Date.now() - scanProgress.startedAt),
          }),
        )
        if (busyCancellable) {
          lines.push('', localize('perforce.status.clickToCancel', 'Click to cancel'))
          this._item.command = 'perforce.cancelBusy'
        } else {
          this._item.command = 'perforce-graph.view'
        }
        this._item.tooltip = lines.join('\n')
        this._item.show()
        return
      }
      this._item.text = `$(server) ${short}: ${busy}… $(sync~spin)`
      if (busyCancellable) {
        this._item.command = 'perforce.cancelBusy'
        this._item.tooltip = localize('perforce.status.cancelTooltip', '{0} — click to cancel', {
          0: busy,
        })
      } else {
        this._item.command = 'perforce-graph.view'
        this._item.tooltip = busy
      }
      this._item.show()
      return
    }
    this._item.showProgress = undefined
    this._item.command = 'perforce-graph.view'
    // Status bar truncates the client name in every state (busy and idle) so the
    // entry width doesn't jump when an operation finishes; the tooltip below
    // keeps the full name.
    const short = truncateClientName(clientName)
    if (connection === 'offline') {
      this._item.text = `$(server) ${short} (${localize('perforce.status.offline', 'offline')})`
    } else if (connection === 'not-logged-in') {
      this._item.text = `$(server) ${short} (${localize('perforce.status.notLoggedIn', 'not logged in')})`
    } else {
      this._item.text = `$(server) ${short} ${openedCount}`
    }
    // Spell the count out in words — plus the graph is what a click opens, which
    // the label alone doesn't say. The target line sits between them: it is the
    // only place a sync's target survives its run (the notification is gone by
    // then), and the action hint stays last, as in the sync branch.
    this._item.tooltip = [
      localize('perforce.status.tooltip', 'Perforce: {0} · {1} opened', {
        0: clientName,
        1: String(openedCount),
      }),
      ...(lastSyncSpec !== undefined
        ? [
            localize('perforce.status.lastSyncTarget', 'Last pull: {0}', {
              0: syncTargetLabel(lastSyncSpec),
            }),
          ]
        : []),
      localize('perforce.status.openGraph', 'Open Perforce Graph'),
    ].join('\n')
    this._item.show()
  }

  /** Re-render the revision chip for the active editor's file. `editor` comes
   *  from the subscription event when available; a bare call re-fetches the
   *  active editor itself (initial render, client refresh). */
  private _renderRev(editor?: TextEditor | undefined): void {
    if (!this._visible) return
    const token = ++this._revToken
    void (async () => {
      const ed = editor ?? (await window.getActiveTextEditor())
      if (token !== this._revToken) return
      // Non-file scheme (untitled, custom editors) has no depot identity.
      const fsPath = ed ? uriToFsPath(ed.document.uri) : undefined
      if (!fsPath) {
        this._revItem.hide()
        return
      }
      const client = this._mgr.resolveContaining(fsPath)
      if (!client) {
        this._revItem.hide()
        return
      }
      let info: FstatInfo | undefined
      try {
        info = await client.fstat(fsPath)
      } catch {
        // fstat rejects when p4 can't spawn — the chip is best-effort, and this
        // async path must never surface an unhandled rejection.
        info = undefined
      }
      if (token !== this._revToken) return
      client.updateBehindFromFstat(fsPath, info)
      this._renderRevInfo(info)
    })()
  }

  private _renderRevInfo(info: FstatInfo | undefined): void {
    // Hidden while the selection points at another provider — an in-flight
    // fstat finishing now must not re-show the chip.
    if (!this._visible) return
    // undefined covers both "fstat failed" and the NOT_CONTROLLED sentinel — an
    // empty `#/#` would claim knowledge we don't have.
    if (!info) {
      this._revItem.hide()
      return
    }
    if (info.action === 'add' || info.haveRev === 'none') {
      // Open for add: there is no have revision yet, so a `#/#` pair would be
      // noise — and on a re-add it would show the deleted file's head revision,
      // which is actively misleading. A marked "new" says what the user needs.
      //
      // Keyed on `action` rather than only `haveRev`: on a real server (P4D
      // 2024.2) fstat OMITS `haveRev` entirely for an open-for-add file — the
      // string `'none'` shows up in `opened` records, not fstat (PROBE-FINDINGS
      // §10). The `'none'` check stays as defence for servers that do report it.
      this._revItem.text = `$(diff-added) ${localize('perforce.status.revAdded', 'new')}`
      this._revItem.command = undefined
      this._revItem.tooltip = localize(
        'perforce.status.revAddedTooltip',
        'New file, not in the depot yet',
      )
      this._revItem.show()
      return
    }
    const have = asRev(info.haveRev)
    const head = asRev(info.headRev)
    if (have === undefined && head === undefined) {
      this._revItem.hide()
      return
    }
    if (have === undefined) {
      // Controlled but with no have revision reported — show what we do know.
      this._revItem.text = `#${head}`
      this._revItem.command = undefined
      this._revItem.tooltip = localize('perforce.status.revHeadTooltip', 'Head revision {0}', {
        0: `#${head}`,
      })
      this._revItem.show()
      return
    }
    if (head === undefined) {
      // A synced file with no head reported — the have revision alone.
      this._revItem.text = `#${have}`
      this._revItem.command = undefined
      this._revItem.tooltip = localize('perforce.status.revHaveTooltip', 'Have revision #{0}', {
        0: have,
      })
      this._revItem.show()
      return
    }
    const behind = have < head
    this._revItem.text = behind ? `#${have} / ↓#${head}` : `#${have} / #${head}`
    // Behind is actionable (click gets the file's latest); current is not. This
    // chip describes ONE file, so it stays on the file-scoped command.
    this._revItem.command = behind ? 'perforce.syncLatest' : undefined
    this._revItem.tooltip = behind
      ? localize(
          'perforce.status.revTooltipBehind',
          'Have revision #{0}, head is #{1} — click to sync this file to the latest revision',
          { 0: have, 1: head },
        )
      : localize('perforce.status.revTooltip', 'Have revision #{0}, head revision #{1}', {
          0: have,
          1: head,
        })
    this._revItem.show()
  }

  dispose(): void {
    this._setSyncHeartbeat(false)
    this._dropSyncRate()
    this._clientSub?.dispose()
    this._editorSub?.dispose()
    this._item.dispose()
    this._revItem.dispose()
  }
}
