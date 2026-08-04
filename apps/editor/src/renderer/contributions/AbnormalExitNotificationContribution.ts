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
    this._notifications.notify({
      severity: Severity.Warning,
      message: hasDumps
        ? localize('abnormalExit.withDumps', '上次会话异常终止，已留下 {count} 个崩溃转储文件。', {
            count: String(report.crashDumps.length),
          })
        : localize(
            'abnormalExit.noDumps',
            '上次会话未正常退出（可能被外部强制终止，如杀毒软件 / 内存不足）。',
          ),
      sticky: true,
      actions: [
        {
          label: localize('abnormalExit.openCrashes', '打开崩溃目录'),
          run: () => {
            void this._diagnostics.revealCrashesFolder()
          },
        },
      ],
    })
  }
}
