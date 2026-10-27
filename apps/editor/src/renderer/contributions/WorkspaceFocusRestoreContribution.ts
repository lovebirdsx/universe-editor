import {
  Disposable,
  IContextKeyService,
  IEditorGroupsService,
  IFocusTrackerService,
  ILoggerService,
  ILayoutService,
  IViewsService,
  IWorkspaceService,
  NullLogger,
  PartId,
  autorun,
  type IDisposable,
  type IEditorGroup,
  type IFocusChangeEvent,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { isHTMLElementLike } from '@universe-editor/workbench-ui'
import { ITerminalManagerService } from '../services/terminal/TerminalManagerService.js'
import { closestPartId } from '../services/focus/FocusStackService.js'
import { restoreWorkbenchFocus } from '../services/focus/workbenchFocusRestorer.js'

const RESTORE_FOCUS_WINDOW_MS = 1500
const RESTORE_FOCUS_DEBOUNCE_MS = 80

export class WorkspaceFocusRestoreContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _groupListeners = new Map<number, IDisposable>()
  private readonly _logger: ILogger
  private _restoreUntil = 0
  private _restoreTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    @IWorkspaceService workspaceService: IWorkspaceService,
    @IEditorGroupsService private readonly _editorGroupsService: IEditorGroupsService,
    @ILayoutService private readonly _layoutService: ILayoutService,
    @IViewsService private readonly _viewsService: IViewsService,
    @IContextKeyService private readonly _contextKeyService: IContextKeyService,
    @ITerminalManagerService terminalManagerService: ITerminalManagerService,
    @ILoggerService loggerService: ILoggerServiceType,
    @IFocusTrackerService focusTracker: IFocusTrackerService,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'workspaceFocusRestore', name: 'Workspace Focus' }) ??
      new NullLogger()

    for (const group of _editorGroupsService.groups) this._attachGroup(group)

    this._register(workspaceService.onDidChangeWorkspace(() => this._beginRestoreWindow()))
    // A workspace switch can leave focus on a stale element, so the window above
    // keeps re-focusing the editor area as restore work replaces it. Once the
    // user moves focus into another part (or an overlay outside every part) they
    // picked their target — a late restore would yank the caret back out of e.g.
    // the search box.
    this._register(focusTracker.onDidFocusChange((e) => this._onFocusChange(e)))
    this._register(
      _editorGroupsService.onDidAddGroup((group) => {
        this._attachGroup(group)
        this._scheduleIfPending('group-add')
      }),
    )
    this._register(
      _editorGroupsService.onDidRemoveGroup((group) => {
        this._groupListeners.get(group.id)?.dispose()
        this._groupListeners.delete(group.id)
        this._scheduleIfPending('group-remove')
      }),
    )
    this._register(
      _editorGroupsService.onDidActiveGroupChange(() => this._scheduleIfPending('active-group')),
    )
    this._register(_editorGroupsService.onDidMoveGroup(() => this._scheduleIfPending('group-move')))

    this._register(
      autorun((reader) => {
        terminalManagerService.panelTerminals.read(reader)
        terminalManagerService.activeTerminalId.read(reader)
        terminalManagerService.activeGroupId.read(reader)
        _layoutService.visible.read(reader)
        this._scheduleIfPending('terminal-or-layout')
      }),
    )
  }

  private _attachGroup(group: IEditorGroup): void {
    if (this._groupListeners.has(group.id)) return
    const modelSub = this._register(
      group.onDidChangeModel(() => this._scheduleIfPending('group-model')),
    )
    const activeSub = this._register(
      group.onDidActiveEditorChange(() => this._scheduleIfPending('active-editor')),
    )
    this._groupListeners.set(group.id, {
      dispose: () => {
        modelSub.dispose()
        activeSub.dispose()
      },
    })
  }

  private _beginRestoreWindow(): void {
    this._restoreUntil = Date.now() + RESTORE_FOCUS_WINDOW_MS
    this._schedule('workspace-change')
  }

  private _onFocusChange(e: IFocusChangeEvent): void {
    if (Date.now() > this._restoreUntil) return
    const el: unknown = e.current
    if (!isHTMLElementLike(el)) return
    // Focus outside every part (quick input, modal dialog) is a user-chosen
    // target too; only focus that stays in the editor area keeps the restore
    // intent alive.
    const part = closestPartId(el)
    if (part === PartId.EditorArea) return
    this._logger.debug(`restore window cancelled by focus in ${part ?? 'an overlay'}`)
    this._cancelRestoreWindow()
  }

  private _cancelRestoreWindow(): void {
    this._restoreUntil = 0
    if (this._restoreTimer !== undefined) {
      clearTimeout(this._restoreTimer)
      this._restoreTimer = undefined
    }
  }

  private _scheduleIfPending(reason: string): void {
    if (Date.now() > this._restoreUntil) return
    this._schedule(reason)
  }

  private _schedule(reason: string): void {
    if (this._restoreTimer !== undefined) clearTimeout(this._restoreTimer)
    this._restoreTimer = setTimeout(() => {
      this._restoreTimer = undefined
      void this._restore(reason)
    }, RESTORE_FOCUS_DEBOUNCE_MS)
  }

  private async _restore(reason: string): Promise<void> {
    if (Date.now() > this._restoreUntil) return
    const result = await restoreWorkbenchFocus(
      this._editorGroupsService,
      this._layoutService,
      this._contextKeyService,
      this._viewsService,
    )
    this._logger.debug(
      `restore focus reason=${reason} target=${result.target} ok=${result.ok}` +
        (result.editorId ? ` editor=${result.editorId}` : ''),
    )
  }

  override dispose(): void {
    this._cancelRestoreWindow()
    for (const listener of this._groupListeners.values()) listener.dispose()
    this._groupListeners.clear()
    super.dispose()
  }
}
