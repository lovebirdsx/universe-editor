/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Seeds the status bar with the default entry. Scheduled at AfterRestore so the
 *  status bar is mounted by the time we mutate it.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStatusBarService,
  IWorkbenchContribution,
  StatusBarAlignment,
} from '@universe-editor/platform'

export class StatusBarDefaultsContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IStatusBarService statusBarService: IStatusBarService) {
    super()

    this._register(
      statusBarService.addEntry({
        text: 'Status Bar',
        tooltip: 'This is the status bar',
        alignment: StatusBarAlignment.Right,
        priority: 100,
      }),
    )
  }
}
