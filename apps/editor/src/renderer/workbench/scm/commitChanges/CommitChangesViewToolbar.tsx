/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CommitChangesViewToolbar — the Commit Changes view's title-bar actions,
 *  rendered in the SideBar header via the view toolbar registry. Leads with an
 *  "Open in Graph" button (reveals the current commit in the provider's
 *  history graph); the collapse/expand-all buttons and the `…` overflow with
 *  the View as List / View as Tree toggle come from the shared changesTree
 *  toolbar pieces. State is shared with the view body through
 *  commitChangesViewState.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry, ICommandService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../../useService.js'
import { ActionButton } from '../scmShared.js'
import {
  ChangesTreeCollapseExpandButtons,
  ChangesTreeViewModeOverflow,
} from '../../changesTree/toolbar.js'
import { commitChangesViewState } from './viewState.js'

/** Command that opens the provider's history graph at a commit. git/perforce
 *  have reveal bridges (`_workbench.*`); other providers fall back to the
 *  `<providerId>-graph.view` naming convention (no reveal argument). Mirrors
 *  the helper in ScmBlameContribution — kept local so this view's module graph
 *  stays free of the blame contribution (and its Monaco imports). */
function openCommitGraphCommand(providerId: string): string {
  if (providerId === 'git') return '_workbench.openGitGraph'
  if (providerId === 'perforce') return '_workbench.openPerforceGraph'
  return `${providerId}-graph.view`
}

export function CommitChangesViewToolbar() {
  const commandService = useService(ICommandService)
  const payload = useObservable(commitChangesViewState.payload)
  const viewMode = useObservable(commitChangesViewState.viewMode)

  const graphCommand = payload !== null ? openCommitGraphCommand(payload.providerId) : null
  const hasGraph = graphCommand !== null && CommandsRegistry.getCommand(graphCommand) !== undefined

  if (payload === null) return null

  return (
    <>
      {hasGraph && graphCommand !== null && (
        <ActionButton
          action={{
            id: 'commitChanges.openInGraph',
            title: localize('commitChanges.openInGraph', 'Open in Graph'),
            command: 'commitChanges.openInGraph',
            icon: 'git-graph',
          }}
          onRun={() =>
            void commandService.executeCommand(
              graphCommand,
              // A compare payload has no single graph row to reveal — its
              // commitRef is "from..to" — so land on the first-picked commit.
              payload.metadata?.compareRefs?.from ?? payload.commitRef,
            )
          }
        />
      )}
      <ChangesTreeCollapseExpandButtons
        viewMode={viewMode}
        commandPrefix="commitChanges"
        onCollapseAll={() => commitChangesViewState.requestCollapseAll()}
        onExpandAll={() => commitChangesViewState.requestExpandAll()}
      />
      <ChangesTreeViewModeOverflow
        viewMode={viewMode}
        onSetViewMode={(mode) => commitChangesViewState.setViewMode(mode)}
      />
    </>
  )
}
