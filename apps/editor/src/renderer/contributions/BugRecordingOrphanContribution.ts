/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Crash fallback for bug recording: a recording that never got a stopRecording()
 *  call still has its raw events on disk. Offer to export it — the crash itself is
 *  usually the bug being chased, so this bundle is the most valuable one.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IDialogService,
  INotificationService,
  localize,
  Severity,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { askRedaction, exportRecording } from '../actions/bugRecordingActions.js'
import {
  IBugRecorderClient,
  type BugRecorderClient,
} from '../services/bugRecording/bugRecorderClient.js'

export class BugRecordingOrphanContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IBugRecorderClient private readonly _recorder: BugRecorderClient,
    @INotificationService private readonly _notifications: INotificationService,
    @IDialogService private readonly _dialogs: IDialogService,
  ) {
    super()
    void this._checkOrphan()
  }

  private async _checkOrphan(): Promise<void> {
    // consume-once in main, so only the first window that asks gets the prompt.
    const orphan = await this._recorder.consumeOrphanRecording()
    if (!orphan) return

    this._notifications.notify({
      severity: Severity.Warning,
      sticky: true,
      message: localize(
        'bugRecording.orphanFound',
        'A bug recording from {time} was interrupted (crash or forced exit). Its {events} recorded events are still on disk.',
        {
          time: new Date(orphan.startedAt).toLocaleString(),
          events: String(orphan.eventCount),
        },
      ),
      actions: [
        {
          label: localize('bugRecording.orphanExport', 'Export Evidence Bundle'),
          run: () => {
            void this._exportOrphan()
          },
        },
      ],
    })
  }

  private async _exportOrphan(): Promise<void> {
    const choice = await askRedaction(this._dialogs, {
      cancelButton: localize('bugRecording.orphanDiscard', 'Not Now'),
    })
    if (choice === 'cancel') return
    await exportRecording(this._notifications, () =>
      this._recorder.exportOrphanRecording({ redact: choice === 'redact' }),
    )
  }
}
