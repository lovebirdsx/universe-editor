/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Registers built-in IViewDescriptors. The companion file-tree component is
 *  bound to its componentKey from SideBar.tsx so this contribution stays
 *  service-free.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWorkbenchContribution,
  ViewRegistry,
  localize,
} from '@universe-editor/platform'

export class BuiltInViewsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.explorer.tree',
        name: localize('view.files', 'Files'),
        containerId: 'workbench.view.explorer',
        componentKey: 'explorer.tree',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.search.results',
        name: localize('view.search', 'Search'),
        containerId: 'workbench.view.search',
        componentKey: 'search.results',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.scm.main',
        name: localize('view.scm', 'Source Control'),
        containerId: 'workbench.view.scm',
        componentKey: 'scm.main',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.output.main',
        name: localize('view.output', 'Output'),
        containerId: 'workbench.view.output',
        componentKey: 'output.main',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.terminal.main',
        name: localize('view.terminal', 'Terminal'),
        containerId: 'workbench.view.terminal',
        componentKey: 'terminal.main',
        order: 1,
      }),
    )
  }
}
