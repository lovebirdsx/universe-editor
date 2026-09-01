/**
 * The Perforce status-bar entries: the main client name + connection state item,
 * plus a behind-count item ("N files behind") that appears only once a
 * behind-check has actually run, plus a revision chip (`#have / #head`) for the
 * active editor's file. All render whichever client is active — switching the
 * SCM selection re-points them, mirroring VSCode's single-repo status bar (and
 * git's GitStatusBarController). Clicking the main item opens the Perforce
 * graph; clicking the behind item pops up a changelist picker to sync the whole
 * scope to, while the revision chip syncs just the file it describes.
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
 * repo; `setVisible(false)` hides all three items and every render
 * short-circuits until a p4 client is selected again.
 */
import {
  window,
  StatusBarAlignment,
  type Disposable,
  type StatusBarItem,
  type TextEditor,
} from '@universe-editor/extension-api'
import type { PerforceClient } from './client.js'
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

export class P4StatusBarController {
  private readonly _item: StatusBarItem
  private readonly _behindItem: StatusBarItem
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
    // Lower priority puts it to the right of the main item.
    this._behindItem = window.createStatusBarItem(StatusBarAlignment.Left, 90)
    // Scope-level, not file-level: this item counts every behind file in the sync
    // scope, so its click must offer whole-scope targets. `perforce.syncLatest`
    // would fall back to the active editor's file and fetch one while the label
    // promises N; `perforce.syncScope` pops a changelist picker instead of a
    // one-shot `#head` get — the newest submit is often not the one you want on.
    this._behindItem.command = 'perforce.syncScope'
    this._behindItem.tooltip = localize(
      'perforce.status.behind.tooltip',
      'Click to pick which changelist to sync this workspace to',
    )
    // Lowest priority sits left of both: `#have / #head` for the active editor's
    // file, its own signal next to (not merged into) the behind count.
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

  /** Show or hide all three items. `false` is pushed via `perforce.setActiveRepo`
   *  when the SCM selection moved to another provider's repo; `true` restores
   *  and re-renders from the active client. */
  setVisible(visible: boolean): void {
    this._visible = visible
    if (!visible) {
      this._item.hide()
      this._behindItem.hide()
      this._revItem.hide()
      return
    }
    this.refresh()
  }

  private _render(): void {
    if (!this._visible) return
    const client = this._mgr.active
    // Before the four-state branches, so no early return can skip it and leave
    // a stale behind count on screen.
    this._renderBehind(client)
    if (!client) {
      this._item.hide()
      return
    }
    const { clientName, connection, openedCount, busy, busyCancellable } = client.status
    if (busy) {
      // A long-running p4 operation is in flight — show a spinner + its label so
      // the user sees the client isn't stalled (mirrors git's syncing indicator).
      // While it's cancellable, clicking cancels instead of opening the graph:
      // without this the only way out of a slow operation is to wait out
      // `perforce.commandTimeout`.
      this._item.text = `$(server) ${clientName}: ${busy}…`
      this._item.showProgress = 'spinning'
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
    if (connection === 'offline') {
      this._item.text = `$(server) ${clientName} (${localize('perforce.status.offline', 'offline')})`
    } else if (connection === 'not-logged-in') {
      this._item.text = `$(server) ${clientName} (${localize('perforce.status.notLoggedIn', 'not logged in')})`
    } else {
      this._item.text = `$(server) ${clientName} ${openedCount}`
    }
    // Spell the count out in words — plus the graph is what a click opens, which
    // the label alone doesn't say.
    this._item.tooltip = `${localize('perforce.status.tooltip', 'Perforce: {0} · {1} opened', {
      0: clientName,
      1: String(openedCount),
    })}\n${localize('perforce.status.openGraph', 'Open Perforce Graph')}`
    this._item.show()
  }

  private _renderBehind(client: PerforceClient | undefined): void {
    if (!this._visible) return
    const behind = client?.status.syncBehindCount
    // undefined = the first behind-check hasn't completed — hiding beats a
    // reassuring zero the client hasn't earned. 0 = checked, nothing to get.
    // The connection gate is explicit even though going offline clears the
    // count upstream: the number means nothing while disconnected, and not
    // relying on the upstream cleanup keeps both sides honest.
    if (!client || !behind || client.status.connection !== 'connected') {
      this._behindItem.hide()
      return
    }
    const capped = client.status.syncBehindCapped
    const text = localize(
      capped ? 'perforce.status.behind.capped' : 'perforce.status.behind',
      capped ? 'more than {0} files behind' : '{0} files behind',
      { 0: behind },
    )
    this._behindItem.text = `$(cloud-download) ${text}`
    this._behindItem.show()
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
    // chip describes ONE file, so it stays on the file-scoped command — the
    // whole-scope get belongs to the behind-count item next to it.
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
    this._behindItem.dispose()
    this._revItem.dispose()
  }
}
