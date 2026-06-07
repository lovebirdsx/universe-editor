/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchResultsTree — file/match results rendered through the generic Tree.
 *
 *  Each match range is its own flat, fixed-height row, so virtualization positions
 *  rows correctly (no overlap when a file group expands) and the TreeModel owns
 *  expansion centrally — enabling auto-expand, collapse-all and the list/tree
 *  view modes driven from the title toolbar via searchViewState.
 *--------------------------------------------------------------------------------------------*/

import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  type IFileMatch,
  type ITextSearchMatch,
  type URI,
  markAsSingleton,
} from '@universe-editor/platform'
import {
  Tree,
  TreeModel,
  useOwnedTreeModel,
  type ITreeDataSource,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import { Folder, FolderOpen } from 'lucide-react'
import { FileIcon } from '../files/fileIconTheme.js'
import { useObservable } from '../useService.js'
import { searchViewState } from './searchViewState.js'
import { searchSession } from './searchSession.js'
import {
  EMPTY_SNAPSHOT,
  buildSearchSnapshot,
  type SearchNode,
  type SearchSnapshot,
} from './searchTree.js'
import styles from './SearchView.module.css'

export interface SearchResultsTreeProps {
  results: readonly IFileMatch[]
  rootUri?: URI | null
  onActivateMatch: (resource: URI, match: ITextSearchMatch, rangeIndex: number) => void
  onReplaceMatch?:
    | ((resource: URI, match: ITextSearchMatch, rangeIndex: number) => void)
    | undefined
  onReplaceFile?: ((resource: URI) => void) | undefined
  replaceVisible?: boolean
}

function highlight(preview: string, range: { startColumn: number; endColumn: number } | undefined) {
  if (!range) return preview
  const start = Math.max(range.startColumn - 1, 0)
  const end = Math.max(range.endColumn - 1, start)
  return [
    preview.slice(0, start),
    <span key="m" className={styles['match']}>
      {preview.slice(start, end)}
    </span>,
    preview.slice(end),
  ]
}

export function SearchResultsTree({
  results,
  rootUri = null,
  onActivateMatch,
  onReplaceFile,
  onReplaceMatch,
  replaceVisible,
}: SearchResultsTreeProps) {
  const viewMode = useObservable(searchViewState.viewMode)

  const snapshotRef = useRef<SearchSnapshot>(EMPTY_SNAPSHOT)
  const model = useOwnedTreeModel<SearchNode>(() => {
    const dataSource: ITreeDataSource<SearchNode> = {
      getId: (n) => n.id,
      hasChildren: (n) => (snapshotRef.current.childrenMap.get(n.id)?.length ?? 0) > 0,
      getChildren: (n) => snapshotRef.current.childrenMap.get(n.id) ?? [],
      getRoots: () => snapshotRef.current.roots,
      getParent: (n) => snapshotRef.current.parentMap.get(n.id) ?? null,
    }
    // Everything expanded by default; restored collapses applied via defaultExpanded
    // so the first render already shows the correct state without a flash.
    return new TreeModel<SearchNode>({
      dataSource,
      defaultExpanded: (n) => !searchSession.treeCollapsedIds.has(n.id),
    })
  })

  const snapshot = useMemo(
    () => buildSearchSnapshot(results, rootUri, viewMode),
    [results, rootUri, viewMode],
  )
  snapshotRef.current = snapshot
  useLayoutEffect(() => {
    // Seed newly-seen expandable nodes, respecting any saved collapsed state from
    // a prior mount so switching views and back preserves user collapses.
    const toSeed = snapshot.expandableIds.filter((id) => !model.hasState(id))
    if (toSeed.length > 0) {
      model.setExpansion(toSeed.map((id) => [id, !searchSession.treeCollapsedIds.has(id)] as const))
    }
    model.refresh()
  }, [snapshot, model])

  // Collapse-all driven from the title toolbar via a shared signal counter.
  const collapseSignal = useObservable(searchViewState.collapseAllSignal)
  const seenCollapse = useRef(collapseSignal)
  useEffect(() => {
    if (collapseSignal === seenCollapse.current) return
    seenCollapse.current = collapseSignal
    model.setExpansion(snapshotRef.current.expandableIds.map((id) => [id, false] as const))
  }, [collapseSignal, model])

  // Persist collapsed nodes to searchSession so switching views and back restores them.
  useEffect(() => {
    const d = markAsSingleton(
      model.onDidChangeStructure(() => {
        searchSession.treeCollapsedIds = new Set(
          snapshotRef.current.expandableIds.filter((id) => !model.isExpanded(id)),
        )
      }),
    )
    return () => d.dispose()
  }, [model])

  const renderRow = (ctx: ITreeRowRenderContext<SearchNode>) => {
    const n = ctx.node.element
    const style: CSSProperties = { paddingLeft: ctx.indentPadding, ...(ctx.style ?? {}) }
    const className = [
      styles['row'],
      ctx.isSelected && styles['selected'],
      ctx.isFocused && styles['focused'],
    ]
      .filter(Boolean)
      .join(' ')

    if (n.kind === 'folder') {
      return (
        <div
          key={n.id}
          data-row-key={n.id}
          role="treeitem"
          aria-expanded={ctx.node.expanded}
          className={className}
          style={style}
          title={n.relPath}
          onClick={ctx.onClickRow}
        >
          <button
            type="button"
            className={styles['twisty']}
            aria-label={`Toggle ${n.name}`}
            onClick={(e) => {
              e.stopPropagation()
              ctx.onToggle()
            }}
          >
            {ctx.node.expanded ? '▾' : '▸'}
          </button>
          <span className={styles['rowIcon']} aria-hidden="true">
            {ctx.node.expanded ? (
              <FolderOpen size={14} strokeWidth={1.75} />
            ) : (
              <Folder size={14} strokeWidth={1.75} />
            )}
          </span>
          <span className={styles['rowLabel']}>{n.name}</span>
          <span className={styles['fileCount']} aria-label={`${n.matchCount} matches`}>
            {n.matchCount}
          </span>
        </div>
      )
    }

    if (n.kind === 'file') {
      return (
        <div
          key={n.id}
          data-row-key={n.id}
          role="treeitem"
          aria-expanded={ctx.node.expanded}
          className={className}
          style={style}
          title={n.relPath}
          onClick={ctx.onClickRow}
        >
          <button
            type="button"
            className={styles['twisty']}
            aria-label={`Toggle ${n.name}`}
            onClick={(e) => {
              e.stopPropagation()
              ctx.onToggle()
            }}
          >
            {ctx.node.expanded ? '▾' : '▸'}
          </button>
          <FileIcon
            resource={n.resource}
            isDirectory={false}
            className={styles['rowIcon']}
            size={14}
          />
          <span className={styles['rowLabel']}>{n.name}</span>
          <span className={styles['fileCount']} aria-label={`${n.matchCount} matches`}>
            {n.matchCount}
          </span>
          {replaceVisible && onReplaceFile && (
            <button
              type="button"
              className={styles['replaceBtn']}
              title="Replace All in File"
              aria-label={`Replace all in ${n.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onReplaceFile(n.resource)
              }}
            >
              ⇄
            </button>
          )}
        </div>
      )
    }

    const range = n.match.ranges[n.rangeIndex]
    return (
      <div
        key={n.id}
        data-row-key={n.id}
        role="treeitem"
        className={className}
        style={style}
        title={n.match.preview}
        onClick={ctx.onClickRow}
      >
        <span className={styles['lineNumber']}>{n.match.lineNumber}</span>
        <span className={styles['matchPreview']}>{highlight(n.match.preview, range)}</span>
        {replaceVisible && onReplaceMatch && (
          <button
            type="button"
            className={styles['replaceBtn']}
            title="Replace"
            aria-label={`Replace match at line ${n.match.lineNumber}`}
            onClick={(e) => {
              e.stopPropagation()
              onReplaceMatch(n.resource, n.match, n.rangeIndex)
            }}
          >
            ⇄
          </button>
        )}
      </div>
    )
  }

  return (
    <Tree<SearchNode>
      model={model}
      className={styles['resultsTree'] ?? ''}
      virtualListClassName={styles['resultsTree'] ?? ''}
      ariaLabel="Search results"
      rowHeight={22}
      indentWidth={10}
      renderRow={renderRow}
      onActivate={(node) => {
        const n = node.element
        if (n.kind === 'match') onActivateMatch(n.resource, n.match, n.rangeIndex)
      }}
    />
  )
}
