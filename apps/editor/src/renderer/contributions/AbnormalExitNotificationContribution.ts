/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Surfaces the previous session's abnormal exit (native crash / external kill)
 *  as a sticky warning with a shortcut to the crash dumps. The main side
 *  detects it via the session sentinel; the report is consume-once, so exactly
 *  one window notifies even with several windows open.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  INotificationService,
  IWorkbenchContribution,
  Severity,
  localize,
} from '@universe-editor/platform'
import { IDiagnosticsService } from '../../shared/ipc/services.js'

export class AbnormalExitNotificationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IDiagnosticsService private readonly _diagnostics: IDiagnosticsService,
    @INotificationService private readonly _notifications: INotificationService,
  ) {
    super()
    void this._checkPreviousSession()
  }

  private async _checkPreviousSession(): Promise<void> {
    const report = await this._diagnostics.consumeAbnormalExitReport()
    if (!report) return
    const hasDumps = report.crashDumps.length > 0
    const diedAround = new Date(report.previousLastAliveAt).toLocaleString()
    this._notifications.notify({
      severity: Severity.Warning,
      message: hasDumps
        ? localize(
            'abnormalExit.withDumps',
            'The previous session terminated abnormally and left {count} crash dump files.',
            {
              count: String(report.crashDumps.length),
            },
          )
        : localize(
            'abnormalExit.noDumps',
            'The previous session did not exit cleanly around {time} (it may have been killed externally, e.g. by antivirus or out of memory).',
            { time: diedAround },
          ),
      sticky: true,
      actions: [
        {
          label: localize('abnormalExit.openCrashes', 'Open Crashes Folder'),
          run: () => {
            void this._diagnostics.revealCrashesFolder()
          },
        },
      ],
    })
  }
}
