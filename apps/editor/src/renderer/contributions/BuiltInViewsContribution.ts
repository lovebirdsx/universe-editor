/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Registers built-in IViewDescriptors. The companion components are bound to
 *  their componentKeys in ViewComponentsContribution so this contribution stays
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
        icon: 'files',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.search.results',
        name: localize('view.search', 'Search'),
        containerId: 'workbench.view.search',
        componentKey: 'search.results',
        icon: 'search',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.scm.main',
        name: localize('view.scm', 'Source Control'),
        containerId: 'workbench.view.scm',
        componentKey: 'scm.main',
        icon: 'source-control',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.sessionChanges.main',
        name: localize('view.sessionChanges', 'Session Changes'),
        containerId: 'workbench.view.sessionChanges',
        componentKey: 'sessionChanges.main',
        icon: 'diff',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.outline.main',
        name: localize('view.outline', 'Outline'),
        containerId: 'workbench.view.outline',
        componentKey: 'outline.main',
        icon: 'outline',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.output.main',
        name: localize('view.output', 'Output'),
        containerId: 'workbench.view.output',
        componentKey: 'output.main',
        icon: 'output',
        order: 1,
      }),
    )

    this._register(
      ViewRegistry.registerView({
        id: 'workbench.view.terminal.main',
        name: localize('view.terminal', 'Terminal'),
        containerId: 'workbench.view.terminal',
        componentKey: 'terminal.main',
        icon: 'terminal',
        order: 1,
      }),
    )
  }
}
