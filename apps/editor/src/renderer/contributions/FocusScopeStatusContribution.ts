/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  FocusScopeStatusContribution — a left-aligned status-bar entry describing the
 *  focus state: "Focus: N folders" while folders are focused, or a warning
 *  "Focus: no folders" when the toggle is on but the set is empty. Clicking it
 *  opens the focus management picker (remove a folder / add folders / exit).
 *  The entry disappears entirely only when focus is off.
 *
 *  The empty-but-enabled state is worth its own text because it is otherwise
 *  invisible: nothing is filtered, so the workbench looks exactly unfocused
 *  while `workspace.focusEnabled` claims the opposite. The commands keep it
 *  empty-set-free, but hand-edited settings and a `false`-cancelled project
 *  layer both reach it.
 *
 *  Also publishes two global context keys:
 *    - `focusScopeActive` — focus resolves to at least one folder. Gates "Add to
 *      Focus", which is indistinguishable from "Focus on This Folder" until
 *      there is an existing set to add to.
 *    - `focusScopeEnabled` — the toggle itself. Gates "Exit Focus Mode", which
 *      must stay reachable in the empty-but-enabled state precisely because that
 *      is the state the user needs a way out of.
 *
 *  Owned here rather than in ContextKeyContribution because the focus lifecycle
 *  already lives in this file; the per-row `explorerResourceIsFocusFolder` key
 *  is scoped to the Explorer context menu and stays there.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IContextKeyService,
  IStatusBarService,
  StatusBarAlignment,
  localize,
  type IContextKey,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { ManageFocusScopeAction } from '../actions/focusScopeActions.js'
import { IFocusScopeService } from '../services/focus/FocusScopeService.js'

export class FocusScopeStatusContribution extends Disposable implements IWorkbenchContribution {
  private _accessor: IStatusBarEntryAccessor | undefined
  private readonly _activeKey: IContextKey<boolean>
  private readonly _enabledKey: IContextKey<boolean>

  constructor(
    @IFocusScopeService private readonly _focusScope: IFocusScopeService,
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @IContextKeyService contextKeyService: IContextKeyService,
  ) {
    super()
    this._activeKey = contextKeyService.createKey<boolean>('focusScopeActive', false)
    this._enabledKey = contextKeyService.createKey<boolean>('focusScopeEnabled', false)
    this._register(this._focusScope.onDidChange(() => this._render()))
    this._register({ dispose: () => this._accessor?.dispose() })
    this._render()
  }

  private _render(): void {
    this._activeKey.set(this._focusScope.active)
    this._enabledKey.set(this._focusScope.enabled)
    const entry = this._entry()
    if (!entry) {
      this._accessor?.dispose()
      this._accessor = undefined
      return
    }
    if (this._accessor) this._accessor.update(entry)
    else this._accessor = this._statusBar.addEntry(entry)
  }

  private _entry(): IStatusBarEntry | undefined {
    if (!this._focusScope.enabled) return undefined
    const base = {
      id: 'focusScope.indicator',
      command: ManageFocusScopeAction.ID,
      alignment: StatusBarAlignment.Left,
      priority: 11,
    } as const

    const count = this._focusScope.folders.length
    if (count === 0) {
      return {
        ...base,
        text: localize('status.focusScope.text.empty', 'Focus: no folders'),
        tooltip: localize(
          'status.focusScope.tooltip.empty',
          'Focus mode is on but no folders are focused, so nothing is filtered. Click to add a folder or turn focus off.',
        ),
        kind: 'prominent',
      }
    }
    return {
      ...base,
      text:
        count === 1
          ? localize('status.focusScope.text.one', 'Focus: 1 folder')
          : localize('status.focusScope.text.many', 'Focus: {count} folders', { count }),
      tooltip: localize(
        'status.focusScope.tooltip',
        'Focusing on:\n{folderList}\n\nClick to manage focused folders.',
        { folderList: this._focusScope.folders.join('\n') },
      ),
    }
  }
}
