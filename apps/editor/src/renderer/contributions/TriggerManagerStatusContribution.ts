/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerManagerStatusContribution — a permanently visible status-bar entry for
 *  the trigger manager. It always exists so the manager is one click away; the
 *  icon and number change with state:
 *    - something needs the user (unconfirmed / auto-paused / offline / erroring)
 *      → "$(zap) N" with the prominent tone, N = distinct affected triggers;
 *    - otherwise runs are active → "$(sync~spin) N" (N = active runs);
 *    - otherwise → "$(zap)".
 *  The tooltip carries the full breakdown and the next scheduled run.
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
import { summarizeTriggerCounts } from '../../shared/triggers/triggerPresentation.js'
import type { TriggerSummary } from '../../shared/triggers/types.js'
import { OpenTriggerManagerAction } from '../actions/triggerActions.js'

const ENTRY_ID = 'triggers'

export class TriggerManagerStatusContribution extends Disposable implements IWorkbenchContribution {
  private readonly _accessor: IStatusBarEntryAccessor
  /** Undefined until the first snapshot arrives (or forever if listing fails). */
  private _summaries: readonly TriggerSummary[] | undefined

  constructor(
    @IStatusBarService statusBar: IStatusBarService,
    @ITriggerMainService private readonly _triggers: ITriggerMainService,
  ) {
    super()
    this._accessor = statusBar.addEntry(this._entry())
    this._register({ dispose: () => this._accessor.dispose() })
    this._register(this._triggers.onDidChangeTriggers((summaries) => this._apply(summaries)))
    void this._triggers.listTriggers().then(
      (summaries) => {
        if (!this._store.isDisposed) this._apply(summaries)
      },
      () => {
        // The manager itself surfaces the failure; the entry stays as a plain
        // launcher rather than disappearing.
      },
    )
  }

  private _apply(summaries: readonly TriggerSummary[]): void {
    this._summaries = summaries
    this._accessor.update(this._entry())
  }

  private _entry(): IStatusBarEntry {
    const counts =
      this._summaries === undefined ? undefined : summarizeTriggerCounts(this._summaries)
    const needsAttention = counts !== undefined && counts.needsAttention > 0
    const running = counts?.running ?? 0
    const text = needsAttention
      ? `$(zap) ${counts?.needsAttention ?? 0}`
      : running > 0
        ? `$(sync~spin) ${running}`
        : '$(zap)'
    return {
      id: ENTRY_ID,
      text,
      tooltip:
        counts?.tooltip ??
        localize(
          'trigger.manager.status.tooltip.loading',
          'Triggers\n\nClick to open the trigger manager.',
        ),
      command: OpenTriggerManagerAction.ID,
      alignment: StatusBarAlignment.Right,
      priority: 5,
      ...(needsAttention ? { kind: 'prominent' as const } : {}),
    }
  }
}
