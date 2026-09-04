/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  AiStatusBarContribution — mounts the bottom-right status-bar cluster (new
 *  session / choose agent / AI quick settings) by binding the
 *  AiStatusBarButtons component to a single status-bar entry via componentKey.
 *  The component is registered BEFORE the entry is added so the first render
 *  can never miss the registry and fall back to the default text rendering.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStatusBarService,
  IWorkbenchContribution,
  StatusBarAlignment,
} from '@universe-editor/platform'
import { StatusBarComponentRegistry } from '../services/statusbar/StatusBarComponentRegistry.js'
import {
  AI_STATUS_BAR_COMPONENT_KEY,
  AiStatusBarButtons,
} from '../workbench/statusbar/AiStatusBarButtons.js'

export class AiStatusBarContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IStatusBarService statusBarService: IStatusBarService) {
    super()

    this._register(
      StatusBarComponentRegistry.register(AI_STATUS_BAR_COMPONENT_KEY, AiStatusBarButtons),
    )
    this._register(
      statusBarService.addEntry({
        id: 'ai',
        text: '',
        alignment: StatusBarAlignment.Right,
        // Right entries sort descending and the container is a plain flex row, so
        // the visually right-most slot is the LOWEST priority. 0 keeps the cluster
        // at the far bottom-right corner (below every existing entry).
        priority: 0,
        componentKey: AI_STATUS_BAR_COMPONENT_KEY,
      }),
    )
  }
}
