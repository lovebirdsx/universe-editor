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
import type { FstatInfo } from './fstatParser.js'
import { localize } from './nls.js'

/** A revision string p4 reported, as a number — `'none'` (open-for-add has no
 *  have revision, PROBE-FINDINGS §3) and anything else non-integer yield
 *  undefined rather than NaN. */
function asRev(v: string | undefined): number | undefined {
  if (!v || v === 'none') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

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

  private _render(): void {
    if (!this._visible) return
    const client = this._mgr.active
    if (!client) {
      this._item.hide()
      return
    }
    const { clientName, connection, openedCount, busy, busyCancellable, scanProgress } =
      client.status
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
    // the label alone doesn't say.
    this._item.tooltip = `${localize('perforce.status.tooltip', 'Perforce: {0} · {1} opened', {
      0: clientName,
      1: String(openedCount),
    })}\n${localize('perforce.status.openGraph', 'Open Perforce Graph')}`
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
    this._clientSub?.dispose()
    this._editorSub?.dispose()
    this._item.dispose()
    this._revItem.dispose()
  }
}
