/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CommitChangesViewToolbar — the Commit Changes view's title-bar actions,
 *  rendered in the SideBar header via the view toolbar registry. Leads with an
 *  "Open in Graph" button (reveals the current commit in the provider's
 *  history graph) plus tree-mode-only collapse/expand-all buttons; the `…`
 *  overflow carries the View as List / View as Tree toggle, mirroring
 *  ScmViewToolbar. State is shared with the view body through
 *  commitChangesViewState.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { CommandsRegistry, ICommandService, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../../useService.js'
import { resolveHeaderIcon } from '../../viewContainerHeader/icon-map.js'
import { ActionButton, TitleOverflowMenu, type OverflowRow } from '../scmShared.js'
import styles from '../ScmView.module.css'
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
  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null)

  const graphCommand = payload !== null ? openCommitGraphCommand(payload.providerId) : null
  const hasGraph = graphCommand !== null && CommandsRegistry.getCommand(graphCommand) !== undefined

  const overflowRows = useMemo<OverflowRow[]>(
    () => [
      viewMode === 'tree'
        ? {
            kind: 'item',
            id: 'view.list',
            label: localize('scm.viewAsList', 'View as List'),
            icon: 'list-view',
            run: () => commitChangesViewState.setViewMode('list'),
          }
        : {
            kind: 'item',
            id: 'view.tree',
            label: localize('scm.viewAsTree', 'View as Tree'),
            icon: 'tree-view',
            run: () => commitChangesViewState.setViewMode('tree'),
          },
    ],
    [viewMode],
  )

  if (payload === null) return null

  const openOverflow = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setOverflow({ x: rect.right - 220, y: rect.bottom + 2 })
  }

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
      {viewMode === 'tree' && (
        <>
          <ActionButton
            action={{
              id: 'commitChanges.collapseAll',
              title: localize('scm.collapseAll', 'Collapse All'),
              command: 'commitChanges.collapseAll',
              icon: 'collapse-all',
            }}
            onRun={() => commitChangesViewState.requestCollapseAll()}
          />
          <ActionButton
            action={{
              id: 'commitChanges.expandAll',
              title: localize('commitChanges.expandAll', 'Expand All'),
              command: 'commitChanges.expandAll',
              icon: 'expand-all',
            }}
            onRun={() => commitChangesViewState.requestExpandAll()}
          />
        </>
      )}
      <button
        type="button"
        className={styles['actionButton']}
        data-tooltip={localize('scm.moreActions', 'More Actions...')}
        aria-label={localize('scm.moreActions', 'More Actions...')}
        onClick={openOverflow}
      >
        {(() => {
          const Icon = resolveHeaderIcon('more')
          return Icon ? <Icon size={16} strokeWidth={1.6} /> : <span>…</span>
        })()}
      </button>
      {overflow && (
        <TitleOverflowMenu
          anchor={overflow}
          rows={overflowRows}
          onClose={() => setOverflow(null)}
        />
      )}
    </>
  )
}
