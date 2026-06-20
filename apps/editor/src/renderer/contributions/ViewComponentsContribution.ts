/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Binds built-in IViewDescriptor.componentKey values to their React components
 *  in the ViewComponentRegistry. Keeps view-descriptor registration
 *  (BuiltInViewsContribution) and component wiring separate so the descriptors
 *  stay service/React-free.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IWorkbenchContribution } from '@universe-editor/platform'
import { ViewComponentRegistry } from '../services/views/ViewComponentRegistry.js'
import { ExplorerView } from '../workbench/explorer/ExplorerView.js'
import { OutlineView } from '../workbench/outline/OutlineView.js'
import { SearchView } from '../workbench/search/SearchView.js'
import { ScmView } from '../workbench/scm/ScmView.js'
import { AgentsView } from '../workbench/agents/AgentsView.js'
import { McpServersView } from '../workbench/agents/McpServersView.js'
import { SessionChangesView } from '../workbench/agents/SessionChangesView.js'
import { OutputView } from '../workbench/panel/output/OutputView.js'
import { TerminalView } from '../workbench/panel/terminal/TerminalView.js'
import { AiDebugView } from '../workbench/aiDebug/AiDebugView.js'

export class ViewComponentsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(ViewComponentRegistry.register('explorer.tree', ExplorerView))
    this._register(ViewComponentRegistry.register('outline.main', OutlineView))
    this._register(ViewComponentRegistry.register('search.results', SearchView))
    this._register(ViewComponentRegistry.register('scm.main', ScmView))
    this._register(ViewComponentRegistry.register('agents.main', AgentsView))
    this._register(ViewComponentRegistry.register('agents.mcp', McpServersView))
    this._register(ViewComponentRegistry.register('sessionChanges.main', SessionChangesView))
    this._register(ViewComponentRegistry.register('output.main', OutputView))
    this._register(ViewComponentRegistry.register('terminal.main', TerminalView))
    this._register(ViewComponentRegistry.register('aiDebug.main', AiDebugView))
  }
}
