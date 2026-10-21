/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WindowTitleContribution — keeps the native window title in sync with the
 *  current workspace folder *and* the active ACP session so Alt+Tab / the
 *  taskbar shows, at a glance, which workspace each window belongs to and what
 *  session it is running. The session segment reflects only this window's main
 *  part: the global activeSession follows focus across windows, so reading it
 *  would stamp an auxiliary window's session onto the parent window title.
 *  With an active session the title reads
 *  "<folder> — <symbol> <session title>" (e.g. "universe-editor3 — ● 修复登录Bug");
 *  with none it falls back to "<folder name> - <parent directory>". A remote
 *  window prepends a "⇄" marker (from the workspace's authority, or the
 *  window's argv authority when the window is empty) so the taskbar
 *  distinguishes remote windows even with no workspace open — the marker sits
 *  at the very front because the taskbar truncates the tail of long titles.
 *  Electron mirrors `document.title` onto the native window title, surfaced
 *  even with `frame: false`. The status symbol maps AcpSessionStatus to a
 *  geometric shape:
 *  ● running · ○ idle · ◌ connecting · ✕ errored · ◆ ask · ☾ dormant (idle-reaped,
 *  wakes on use; closed → no session segment); background (agent still
 *  executing run_in_background tasks) shares running's ● because the session
 *  is still busy.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  IEditorGroupsService,
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
import { AcpSessionEditorInput } from '../services/acp/session/acpSessionEditorInput.js'
import {
  computeSessionDisplayStatus,
  type AcpSessionDisplayStatus,
} from '../services/acp/session/acpSessionStatus.js'
import {
  formatWindowTitle,
  resolveLiveSessionTitle,
  truncateSessionTitle,
} from '../services/acp/session/acpSessionTitle.js'
import { currentRemoteAuthority } from '../services/remote/windowRemoteAuthority.js'
import { REMOTE_MARKER, workspaceParentLabel } from '../services/workspace/workspaceLabel.js'

const STATUS_SYMBOL: Record<AcpSessionDisplayStatus, string> = {
  running: '●',
  idle: '○',
  connecting: '◌',
  errored: '✕',
  ask: '◆',
  background: '●',
  dormant: '☾',
  closed: '',
}

export class WindowTitleContribution extends Disposable implements IWorkbenchContribution {
  // `IWorkspaceService.current` is event-driven, not observable; bump this rev
  // on workspace change so the single autorun recomputes the title.
  private readonly _workspaceRev = observableValue<number>('windowTitle.workspaceRev', 0)

  // `IEditorGroupModel.activeEditor` is a plain getter (not observable), so
  // model/active-editor events bump this rev to drive the single autorun.
  private readonly _activeEditorRev = observableValue<number>('windowTitle.activeEditorRev', 0)
  private readonly _groupListeners = this._register(new DisposableStore())

  constructor(
    @IWorkspaceService private readonly _workspaceService: IWorkspaceService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
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
    this._register(this._groups.mainPart.onDidActiveGroupChange(() => this._bindActiveGroup()))
    this._bindActiveGroup()
    this._register(autorun((r) => this._update(r)))
  }

  private _bindActiveGroup(): void {
    this._groupListeners.clear()
    const group = this._groups.mainPart.activeGroup
    this._groupListeners.add(group.onDidChangeModel(() => this._bumpActiveEditor()))
    this._groupListeners.add(group.onDidActiveEditorChange(() => this._bumpActiveEditor()))
    this._bumpActiveEditor()
  }

  private _bumpActiveEditor(): void {
    this._activeEditorRev.set(this._activeEditorRev.get() + 1, undefined)
  }

  private _update(r: IReader): void {
    this._workspaceRev.read(r)
    this._activeEditorRev.read(r)
    // Session instances register asynchronously (restored tabs) and can be
    // replaced on hot reconnect; re-resolve so the title follows the registry.
    this._sessions.sessions.read(r)
    const workspace = this._workspaceService.current
    const appName = localize('app.name', 'Universe Editor')
    // Extension-development host instances get a mode badge, like VSCode's
    // "[Extension Development Host]" — a dev window must be visually
    // distinguishable from the main instance at a glance (Alt+Tab / taskbar).
    const devHostBadge =
      window[EXTENSION_DEVELOPMENT_ENABLED_KEY] === true
        ? localize('windowTitle.extDevHost', '[Extension Development Host]')
        : undefined
    // Remote windows prepend the "⇄" marker — also for an empty window, where
    // the authority comes from argv (remote "New Window").
    const authority = currentRemoteAuthority(workspace)
    const remotePrefix = authority !== undefined ? REMOTE_MARKER : undefined
    if (!workspace) {
      document.title = formatWindowTitle({ appName, remotePrefix, devHostBadge })
      return
    }
    const parent = workspaceParentLabel(workspace.folder)

    const activeEditor = this._groups.mainPart.activeGroup.activeEditor
    const session =
      activeEditor instanceof AcpSessionEditorInput
        ? this._sessions.getById(activeEditor.sessionId)
        : undefined
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
      remotePrefix,
      devHostBadge,
    })
  }
}
