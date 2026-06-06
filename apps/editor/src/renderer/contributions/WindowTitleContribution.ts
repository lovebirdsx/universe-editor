/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WindowTitleContribution — keeps the native window title in sync with the
 *  current workspace folder *and* the active ACP session so Alt+Tab / the
 *  taskbar shows, at a glance, which workspace each window belongs to and what
 *  session it is running. With an active session the title reads
 *  "<folder> — <symbol> <session title>" (e.g. "universe-editor3 — ● 修复登录Bug");
 *  with none it falls back to "<folder name> - <parent directory>". Electron
 *  mirrors `document.title` onto the native window title, surfaced even with
 *  `frame: false`. The status symbol maps AcpSessionStatus to a geometric shape:
 *  ● running · ○ idle · ◌ connecting · ✕ errored (closed → no session segment).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkspaceService,
  autorun,
  localize,
  observableValue,
  type IReader,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'
import { IAcpSessionHistoryService } from '../services/acp/acpSessionHistory.js'
import {
  computeSessionDisplayStatus,
  type AcpSessionDisplayStatus,
} from '../services/acp/acpSessionStatus.js'
import {
  formatWindowTitle,
  resolveLiveSessionTitle,
  truncateSessionTitle,
} from '../services/acp/acpSessionTitle.js'

const STATUS_SYMBOL: Record<AcpSessionDisplayStatus, string> = {
  running: '●',
  idle: '○',
  connecting: '◌',
  errored: '✕',
  ask: '◆',
  closed: '',
}

export class WindowTitleContribution extends Disposable implements IWorkbenchContribution {
  // `IWorkspaceService.current` is event-driven, not observable; bump this rev
  // on workspace change so the single autorun recomputes the title.
  private readonly _workspaceRev = observableValue<number>('windowTitle.workspaceRev', 0)

  constructor(
    @IWorkspaceService private readonly _workspaceService: IWorkspaceService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
  ) {
    super()
    this._register(
      this._workspaceService.onDidChangeWorkspace(() =>
        this._workspaceRev.set(this._workspaceRev.get() + 1, undefined),
      ),
    )
    void this._workspaceService.whenReady.then(() =>
      this._workspaceRev.set(this._workspaceRev.get() + 1, undefined),
    )
    this._register(autorun((r) => this._update(r)))
  }

  private _update(r: IReader): void {
    this._workspaceRev.read(r)
    const workspace = this._workspaceService.current
    const appName = localize('app.name', 'Universe Editor')
    if (!workspace) {
      document.title = appName
      return
    }
    const parentPath = workspace.folder.path.replace(/\/[^/]+\/?$/, '')
    const parent = workspace.folder.with({ path: parentPath }).fsPath

    const session = this._sessions.activeSession.read(r)
    // Subscribe to history entries so renames update the window title too.
    this._history.entries.read(r)
    let symbol: string | undefined
    let sessionTitle: string | undefined
    if (session) {
      const status = computeSessionDisplayStatus(session, r)
      if (status !== 'closed') {
        symbol = STATUS_SYMBOL[status]
        const raw = resolveLiveSessionTitle(this._history, this._sessions, session.id)
        sessionTitle = raw !== undefined ? truncateSessionTitle(raw) : undefined
      }
    }

    document.title = formatWindowTitle({
      appName,
      workspaceName: workspace.name,
      parent,
      symbol,
      sessionTitle,
    })
  }
}
