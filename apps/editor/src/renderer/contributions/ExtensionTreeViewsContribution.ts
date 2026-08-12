/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Binds the shared extension tree-view componentKey to its (placeholder)
 *  component. The binding is static and registered exactly once — extension
 *  views come and go with contribution re-translation, but they all render
 *  through this one component, which receives its view id via props.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IWorkbenchContribution } from '@universe-editor/platform'
import { ViewComponentRegistry } from '../services/views/ViewComponentRegistry.js'
import { EXTENSION_TREE_VIEW_COMPONENT_KEY } from '../services/views/extensionViews.js'
import { ExtensionTreeView } from '../workbench/extensionViews/ExtensionTreeView.js'

export class ExtensionTreeViewsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      ViewComponentRegistry.register(EXTENSION_TREE_VIEW_COMPONENT_KEY, ExtensionTreeView),
    )
  }
}
