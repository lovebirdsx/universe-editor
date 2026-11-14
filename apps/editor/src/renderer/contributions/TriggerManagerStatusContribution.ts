/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerManagerStatusContribution — a status-bar entry that exists only while
 *  something needs the user (running / unconfirmed / auto-paused / offline /
 *  erroring triggers). Clicking it opens the manager (the entry's `command`).
 *  It is deliberately silent when everything is idle so the bar stays uncluttered.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStatusBarService,
  IWorkbenchContribution,
  StatusBarAlignment,
  localize,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../shared/ipc/triggerService.js'
import {
  summarizeTriggerCounts,
  type TriggerCountSummary,
} from '../../shared/triggers/triggerPresentation.js'
import type { TriggerSummary } from '../../shared/triggers/types.js'
import { OpenTriggerManagerAction } from '../actions/triggerActions.js'

const ENTRY_ID = 'triggers'

export class TriggerManagerStatusContribution extends Disposable implements IWorkbenchContribution {
  private _accessor: IStatusBarEntryAccessor | undefined
  private _counts: TriggerCountSummary = { text: '', visible: false }

  constructor(
    @IStatusBarService private readonly _statusBar: IStatusBarService,
    @ITriggerMainService private readonly _triggers: ITriggerMainService,
  ) {
    super()
    this._register(this._triggers.onDidChangeTriggers((summaries) => this._apply(summaries)))
    this._register({ dispose: () => this._disposeEntry() })
    void this._triggers.listTriggers().then(
      (summaries) => {
        if (!this._store.isDisposed) this._apply(summaries)
      },
      () => {
        // The manager itself surfaces the failure; the status bar stays silent.
      },
    )
  }

  private _apply(summaries: readonly TriggerSummary[]): void {
    this._counts = summarizeTriggerCounts(summaries)
    const entry = this._entry()
    if (entry === undefined) {
      this._disposeEntry()
      return
    }
    if (this._accessor !== undefined) this._accessor.update(entry)
    else this._accessor = this._statusBar.addEntry(entry)
  }

  private _entry(): IStatusBarEntry | undefined {
    if (!this._counts.visible) return undefined
    return {
      id: ENTRY_ID,
      text: `⚡ ${this._counts.text}`,
      tooltip: localize(
        'trigger.manager.status.tooltip',
        'Triggers: {summary}\n\nClick to open the trigger manager.',
        { summary: this._counts.text },
      ),
      command: OpenTriggerManagerAction.ID,
      alignment: StatusBarAlignment.Right,
      priority: 5,
    }
  }

  private _disposeEntry(): void {
    this._accessor?.dispose()
    this._accessor = undefined
  }
}
