/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  StatusBarComponentsContribution — binds status-bar `componentKey`s to their React
 *  components. BlockStartup so the mapping exists before the status bar first paints.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IWorkbenchContribution } from '@universe-editor/platform'
import { StatusBarComponentRegistry } from '../services/statusbar/StatusBarComponentRegistry.js'
import { AiStatusBarItem } from '../workbench/statusbar/AiStatusBarItem.js'

export class StatusBarComponentsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(StatusBarComponentRegistry.register('statusbar.ai', AiStatusBarItem))
  }
}
