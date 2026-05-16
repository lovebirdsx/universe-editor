/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Registers built-in IViewDescriptors. The companion file-tree component is
 *  bound to its componentKey from SideBar.tsx so this contribution stays
 *  service-free.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IWorkbenchContribution, ViewRegistry } from '@universe-editor/platform'

export class BuiltInViewsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.explorer.tree',
        name: 'Files',
        containerId: 'workbench.view.explorer',
        componentKey: 'explorer.tree',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.search.results',
        name: 'Search',
        containerId: 'workbench.view.search',
        componentKey: 'search.results',
        order: 1,
      }),
    )
  }
}
