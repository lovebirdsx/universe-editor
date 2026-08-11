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
 *  ● running · ○ idle · ◌ connecting · ✕ errored · ◆ ask (closed → no session
 *  segment); background (agent still executing run_in_background tasks) shares
 *  running's ● because the session is still busy.
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
import { EXTENSION_DEVELOPMENT_ENABLED_KEY } from '../../shared/extensionDevelopment.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../services/acp/session/acpSessionHistory.js'
import {
  computeSessionDisplayStatus,
  type AcpSessionDisplayStatus,
} from '../services/acp/session/acpSessionStatus.js'
import {
  formatWindowTitle,
  resolveLiveSessionTitle,
  truncateSessionTitle,
} from '../services/acp/session/acpSessionTitle.js'

const STATUS_SYMBOL: Record<AcpSessionDisplayStatus, string> = {
  running: '●',
  idle: '○',
  connecting: '◌',
  errored: '✕',
  ask: '◆',
  background: '●',
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
    // Extension-development host instances get a mode badge, like VSCode's
    // "[Extension Development Host]" — a dev window must be visually
    // distinguishable from the main instance at a glance (Alt+Tab / taskbar).
    const devHostBadge =
      window[EXTENSION_DEVELOPMENT_ENABLED_KEY] === true
        ? localize('windowTitle.extDevHost', '[Extension Development Host]')
        : undefined
    if (!workspace) {
      document.title = formatWindowTitle({ appName, devHostBadge })
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
      devHostBadge,
    })
  }
}
