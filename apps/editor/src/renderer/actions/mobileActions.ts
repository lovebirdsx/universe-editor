/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mobile gateway settings command.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { MobileDevicesEditorInput } from '../services/editor/MobileDevicesEditorInput.js'
import { invocationOpenTarget } from '../services/editor/openTarget.js'
import { openSingletonEditor, openTargetServicesFrom } from '../services/editor/openWithTarget.js'

export class OpenMobileDevicesSettingsAction extends Action2 {
  static readonly ID = 'workbench.action.mobile.openSettings'

  constructor() {
    super({
      id: OpenMobileDevicesSettingsAction.ID,
      title: localize2('action.mobile.openSettings', 'Open Mobile Devices Settings'),
      category: localize2('command.category.preferences', 'Preferences'),
      icon: 'settings-gear',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const editorService = accessor.get(IEditorService)
    const services = openTargetServicesFrom(accessor)
    const target = invocationOpenTarget()
    await openSingletonEditor(
      services,
      target,
      () => new MobileDevicesEditorInput(),
      () => editorService.openEditor(new MobileDevicesEditorInput(), { activate: true }),
    )
  }
}
