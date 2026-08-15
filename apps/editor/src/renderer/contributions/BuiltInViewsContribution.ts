/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Registers built-in views together with their React components via the
 *  single-point `registerViewWithComponent` API, so the descriptor and the
 *  component binding live in one place and the componentKey is derived from the
 *  view id (no cross-file hardcoded strings).
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IWorkbenchContribution, localize } from '@universe-editor/platform'
import { registerViewWithComponent } from '../services/views/ViewComponentRegistry.js'
import { COMMIT_CHANGES_VIEW_ID } from '../actions/commitChangesActions.js'
import { SESSION_CHANGES_VIEW_ID } from '../actions/agentTimelineActions.js'
import { ExplorerView } from '../workbench/explorer/ExplorerView.js'
import { ExplorerViewToolbar } from '../workbench/explorer/ExplorerViewToolbar.js'
import { OutlineView } from '../workbench/outline/OutlineView.js'
import { OutlineViewToolbar } from '../workbench/outline/OutlineViewToolbar.js'
import { SearchView } from '../workbench/search/SearchView.js'
import { SearchViewToolbar } from '../workbench/search/SearchViewToolbar.js'
import { ScmView } from '../workbench/scm/ScmView.js'
import { ScmViewToolbar } from '../workbench/scm/ScmViewToolbar.js'
import { CommitChangesView } from '../workbench/scm/commitChanges/CommitChangesView.js'
import { CommitChangesViewToolbar } from '../workbench/scm/commitChanges/CommitChangesViewToolbar.js'
import { TimelineView } from '../workbench/timeline/TimelineView.js'
import { TimelineViewToolbar } from '../workbench/timeline/TimelineViewToolbar.js'
import { SessionChangesView } from '../workbench/agents/SessionChangesView.js'
import { SessionChangesViewToolbar } from '../workbench/agents/SessionChangesViewToolbar.js'
import { OutputView } from '../workbench/panel/output/OutputView.js'
import { OutputViewToolbar } from '../workbench/panel/output/OutputViewToolbar.js'
import { TerminalView } from '../workbench/panel/terminal/TerminalView.js'
import { TerminalViewToolbar } from '../workbench/panel/terminal/TerminalViewToolbar.js'
import { AiDebugView } from '../workbench/aiDebug/AiDebugView.js'
import { SshTargetsView } from '../workbench/remote/SshTargetsView.js'
import { SshTargetsViewToolbar } from '../workbench/remote/SshTargetsViewToolbar.js'
import { WslTargetsView } from '../workbench/remote/WslTargetsView.js'
import { ConnectionsView } from '../workbench/remote/ConnectionsView.js'
import { ConnectionsViewToolbar } from '../workbench/remote/ConnectionsViewToolbar.js'
import { RemoteRecentView } from '../workbench/remote/RemoteRecentView.js'
import { RecentViewToolbar } from '../workbench/remote/RecentViewToolbar.js'

export class BuiltInViewsContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.explorer.tree',
          name: localize('view.files', 'Files'),
          containerId: 'workbench.view.explorer',
          icon: 'files',
          order: 1,
        },
        ExplorerView,
        ExplorerViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.timeline.main',
          name: localize('view.timeline', 'Timeline'),
          containerId: 'workbench.view.explorer',
          icon: 'history',
          order: 2,
        },
        TimelineView,
        TimelineViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.search.results',
          name: localize('view.search', 'Search'),
          containerId: 'workbench.view.search',
          icon: 'search',
          order: 1,
        },
        SearchView,
        SearchViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.scm.main',
          name: localize('view.scm', 'Source Control'),
          containerId: 'workbench.view.scm',
          icon: 'source-control',
          order: 1,
        },
        ScmView,
        ScmViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: COMMIT_CHANGES_VIEW_ID,
          name: localize('view.commitChanges', 'Commit Changes'),
          containerId: 'workbench.view.scm',
          icon: 'diff',
          order: 2,
        },
        CommitChangesView,
        CommitChangesViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: SESSION_CHANGES_VIEW_ID,
          name: localize('view.sessionChanges', 'Session Changes'),
          containerId: 'workbench.view.sessionChanges',
          icon: 'diff',
          order: 1,
        },
        SessionChangesView,
        SessionChangesViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.remote.targets',
          name: localize('remote.section.targets', 'SSH Targets'),
          containerId: 'workbench.view.remote',
          icon: 'remote',
          order: 1,
        },
        SshTargetsView,
        SshTargetsViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.remote.wsl',
          name: localize('remote.section.wslTargets', 'WSL Targets'),
          containerId: 'workbench.view.remote',
          icon: 'terminal',
          order: 2,
          when: 'hasWslDistros',
        },
        WslTargetsView,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.remote.connections',
          name: localize('remote.section.connections', 'Connections'),
          containerId: 'workbench.view.remote',
          icon: 'remote',
          order: 3,
        },
        ConnectionsView,
        ConnectionsViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.remote.recent',
          name: localize('remote.section.recent', 'Recent'),
          containerId: 'workbench.view.remote',
          icon: 'history',
          order: 4,
        },
        RemoteRecentView,
        RecentViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.aiDebug.main',
          name: localize('view.aiDebug', 'AI Debug'),
          containerId: 'workbench.view.aiDebug',
          icon: 'debug-alt',
          order: 1,
        },
        AiDebugView,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.outline.main',
          name: localize('view.outline', 'Outline'),
          containerId: 'workbench.view.outline',
          icon: 'outline',
          order: 1,
        },
        OutlineView,
        OutlineViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.output.main',
          name: localize('view.output', 'Output'),
          containerId: 'workbench.view.output',
          icon: 'output',
          order: 1,
        },
        OutputView,
        OutputViewToolbar,
      ),
    )

    this._register(
      registerViewWithComponent(
        {
          id: 'workbench.view.terminal.main',
          name: localize('view.terminal', 'Terminal'),
          containerId: 'workbench.view.terminal',
          icon: 'terminal',
          order: 1,
        },
        TerminalView,
        TerminalViewToolbar,
      ),
    )
  }
}
