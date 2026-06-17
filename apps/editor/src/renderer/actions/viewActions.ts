/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  View management actions. Moving views / containers is done by dragging their
 *  title bar or activity-bar icon (see workbench/dnd); the only command left is a
 *  reset back to registry defaults.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IViewDescriptorService,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'

const CATEGORY = localize('command.category.view', 'View')

export class ResetViewLocationsAction extends Action2 {
  static readonly ID = 'workbench.action.resetViewLocations'

  constructor() {
    super({
      id: ResetViewLocationsAction.ID,
      title: localize('action.resetViewLocations.title', 'Reset View Locations'),
      category: CATEGORY,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IViewDescriptorService).reset()
  }
}
