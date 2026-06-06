/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmViewToolbar — the Source Control view's title-bar actions, rendered in the
 *  SideBar header (single-view container) via viewToolbarMap. Hoists what used
 *  to live in each provider's inline header: navigation icons (for the lone
 *  provider) plus a `…` overflow with the view-mode toggle, collapse-all and
 *  each provider's non-navigation `scm/title` actions. With multiple providers
 *  the navigation icons stay inline in each provider section; the overflow then
 *  aggregates their actions under per-provider sub-headers.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ICommandService, MenuId, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import { IScmService } from '../../services/extensions/ScmService.js'
import {
  ActionButton,
  TitleOverflowMenu,
  menuActions,
  menuToRows,
  useMenuRevision,
  type OverflowRow,
} from './scmShared.js'
import { scmViewState } from './scmViewState.js'
import styles from './ScmView.module.css'

export function ScmViewToolbar() {
  const scm = useService(IScmService)
  const commandService = useService(ICommandService)
  const sourceControls = useObservable(scm.sourceControls)
  const viewMode = useObservable(scmViewState.viewMode)
  const revision = useMenuRevision()
  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null)

  const single = sourceControls.length === 1 ? sourceControls[0] : undefined

  const navActions = useMemo(
    () => (single ? menuActions(MenuId.ScmTitle, { scmProvider: single.id }, 'navigation') : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [single?.id, revision],
  )

  const runCommand = (command: string, providerId: string | undefined): void => {
    void commandService.executeCommand(
      command,
      providerId ? { sourceControlId: providerId } : undefined,
    )
  }

  const overflowRows = useMemo<OverflowRow[]>(() => {
    const rows: OverflowRow[] = [
      viewMode === 'tree'
        ? {
            kind: 'item',
            id: 'view.list',
            label: localize('scm.viewAsList', 'View as List'),
            icon: 'list-view',
            run: () => scmViewState.setViewMode('list'),
          }
        : {
            kind: 'item',
            id: 'view.tree',
            label: localize('scm.viewAsTree', 'View as Tree'),
            icon: 'tree-view',
            run: () => scmViewState.setViewMode('tree'),
          },
      {
        kind: 'item',
        id: 'view.collapseAll',
        label: localize('scm.collapseAll', 'Collapse All'),
        icon: 'collapse-all',
        run: () => scmViewState.requestCollapseAll(),
      },
    ]
    const multi = sourceControls.length > 1
    for (const sc of sourceControls) {
      const scRows = menuToRows(MenuId.ScmTitle, { scmProvider: sc.id }, (cmd) =>
        runCommand(cmd, sc.id),
      )
      if (scRows.length === 0) continue
      rows.push({ kind: 'separator', id: `sep-${sc.id}`, ...(multi ? { label: sc.label } : {}) })
      rows.push(...scRows)
    }
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceControls, viewMode, revision])

  if (sourceControls.length === 0) return null

  const openOverflow = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setOverflow({ x: rect.right - 220, y: rect.bottom + 2 })
  }

  return (
    <>
      {navActions.map((a) => (
        <ActionButton key={a.id} action={a} onRun={() => runCommand(a.command, single?.id)} />
      ))}
      <button
        type="button"
        className={styles['actionButton']}
        title={localize('scm.moreActions', 'More Actions...')}
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
