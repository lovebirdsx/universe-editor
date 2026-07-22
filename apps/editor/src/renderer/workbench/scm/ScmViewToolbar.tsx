/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmViewToolbar — the Source Control view's title-bar actions, rendered in the
 *  SideBar header (single-view container) via the view toolbar registry. With more than one
 *  repo it leads with a compact repo selector (the view shows one repo at a
 *  time); the navigation icons and `…` overflow always target the selected repo.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { ICommandService, MenuId, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import { IScmService, type IScmSourceControlModel } from '../../services/extensions/ScmService.js'
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

/** The repo's folder name (main → project dir, submodule → submodule dir). */
function repoShortName(sc: IScmSourceControlModel): string {
  const p = (sc.rootUri ?? sc.label).replace(/[\\/]+$/, '')
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/** Pending-command key: scoped to the repo so one repo's long-running refresh
 * doesn't lock another repo's button. */
function pendingKey(command: string, rootUri: string | undefined): string {
  return `${command}@${rootUri ?? ''}`
}

export function ScmViewToolbar() {
  const scm = useService(IScmService)
  const commandService = useService(ICommandService)
  const sourceControls = useObservable(scm.sourceControls)
  const selectedRootUri = useObservable(scmViewState.selectedRepo)
  const viewMode = useObservable(scmViewState.viewMode)
  const revision = useMenuRevision()
  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null)
  const [repoMenu, setRepoMenu] = useState<{ x: number; y: number } | null>(null)

  const selected = sourceControls.find((sc) => sc.rootUri === selectedRootUri) ?? sourceControls[0]
  const multi = sourceControls.length > 1

  /** Commands currently in flight (keyed by repo); driving the disabled +
   * spinner state of the title buttons until the command settles. */
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  const navActions = useMemo(
    () =>
      selected ? menuActions(MenuId.ScmTitle, { scmProvider: selected.id }, 'navigation') : [],
    // All git repos share the id `git`; rootUri is what distinguishes the selected
    // one, so the menus (and the runCommand closure they capture) must recompute on
    // rootUri change, not id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected?.rootUri, revision],
  )

  const runCommand = useCallback(
    (command: string): void => {
      const key = pendingKey(command, selected?.rootUri)
      setPending((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
      void commandService
        .executeCommand(
          command,
          selected ? { rootUri: selected.rootUri, sourceControlId: selected.id } : undefined,
        )
        // CommandService already logs the failure; the button must recover either way.
        .catch(() => undefined)
        .finally(() =>
          setPending((prev) => {
            if (!prev.has(key)) return prev
            const next = new Set(prev)
            next.delete(key)
            return next
          }),
        )
    },
    [commandService, selected],
  )

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
    if (selected) {
      const scRows = menuToRows(MenuId.ScmTitle, { scmProvider: selected.id }, (cmd) =>
        runCommand(cmd),
      )
      if (scRows.length > 0) {
        rows.push({ kind: 'separator', id: 'sep-provider' })
        rows.push(...scRows)
      }
    }
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.rootUri, selected?.id, viewMode, revision, runCommand])

  const repoRows = useMemo<OverflowRow[]>(
    () =>
      sourceControls.map((sc) => ({
        kind: 'item',
        id: String(sc.handle),
        label: repoShortName(sc),
        ...(sc === selected ? { icon: 'check' } : {}),
        run: () => scmViewState.setSelectedRepo(sc.rootUri),
      })),
    [sourceControls, selected],
  )

  if (sourceControls.length === 0) return null

  const openOverflow = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setOverflow({ x: rect.right - 220, y: rect.bottom + 2 })
  }
  const openRepoMenu = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setRepoMenu({ x: rect.left, y: rect.bottom + 2 })
  }

  return (
    <>
      {multi && selected && (
        <button
          type="button"
          className={styles['repoSelector']}
          title={selected.label}
          onClick={openRepoMenu}
        >
          <span className={styles['repoSelectorLabel']}>{repoShortName(selected)}</span>
          <ChevronDown
            size={12}
            strokeWidth={1.75}
            className={styles['repoSelectorChevron']}
            aria-hidden="true"
          />
        </button>
      )}
      {navActions.map((a) => (
        <ActionButton
          key={a.id}
          action={a}
          busy={pending.has(pendingKey(a.command, selected?.rootUri))}
          onRun={() => runCommand(a.command)}
        />
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
      {repoMenu && (
        <TitleOverflowMenu anchor={repoMenu} rows={repoRows} onClose={() => setRepoMenu(null)} />
      )}
    </>
  )
}
