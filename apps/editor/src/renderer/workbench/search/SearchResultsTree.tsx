/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchResultsTree — file/match results rendered through the generic Tree.
 *
 *  Each match range is its own flat, fixed-height row, so virtualization positions
 *  rows correctly (no overlap when a file group expands) and the TreeModel owns
 *  expansion centrally — enabling auto-expand, collapse-all and the list/tree
 *  view modes driven from the title toolbar via searchViewState.
 *--------------------------------------------------------------------------------------------*/

import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type IFileMatch,
  type ITextSearchMatch,
  type URI,
  IConfigurationService,
  localize,
  markAsSingleton,
} from '@universe-editor/platform'
import {
  Tree,
  TreeModel,
  useOwnedTreeModel,
  resourceDragProps,
  selectionDragUris,
  type ITreeDataSource,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { FileIcon } from '../files/fileIconTheme.js'
import { resourceDisplayPath } from '../../services/files/fileSystemScheme.js'
import { recordPerfPhase } from '../../services/performance/perfPhases.js'
import { useObservable, useOptionalService } from '../useService.js'
import { searchViewState } from './searchViewState.js'
import { searchSession } from './searchSession.js'
import {
  EMPTY_SNAPSHOT,
  buildSearchSnapshot,
  type SearchBuildContext,
  type SearchNode,
  type SearchSnapshot,
} from './searchTree.js'
import {
  SearchResultsContextMenu,
  type SearchContextMenuState,
  type SearchMenuItem,
} from './SearchResultsContextMenu.js'
import styles from './SearchView.module.css'

/** Mirrors VSCode's `search.collapseResults` auto threshold. */
const AUTO_COLLAPSE_THRESHOLD = 10

type CollapseResults = 'auto' | 'alwaysCollapse' | 'alwaysExpand'

/**
 * What `search.collapseResults` alone would choose for a node. `alwaysExpand`
 * (the default, as in VSCode) keeps every file open; `auto` folds any container
 * holding many matches, which is what keeps the visible-row count near the file
 * count on huge result sets.
 *
 * Mirrors VSCode's searchView.shouldCollapse: the threshold applies to every
 * non-match node, so folders fold on the same rule as files.
 */
function policyExpanded(node: SearchNode, mode: CollapseResults): boolean {
  if (mode === 'alwaysCollapse') return false
  if (mode === 'auto' && node.kind !== 'match' && node.matchCount > AUTO_COLLAPSE_THRESHOLD) {
    return false
  }
  return true
}

/** The policy default, unless the user expanded/collapsed this node by hand. */
function resolveExpanded(node: SearchNode, mode: CollapseResults): boolean {
  return searchSession.treeExpansionOverrides.get(node.id) ?? policyExpanded(node, mode)
}

export interface SearchResultsTreeProps {
  results: readonly IFileMatch[]
  rootUri?: URI | null
  onActivateMatch: (
    resource: URI,
    match: ITextSearchMatch,
    rangeIndex: number,
    preview?: boolean,
  ) => void
  onReplaceMatch?:
    | ((resource: URI, match: ITextSearchMatch, rangeIndex: number) => void)
    | undefined
  onReplaceFile?: ((resource: URI) => void) | undefined
  onDismissMatch?:
    | ((resource: URI, match: ITextSearchMatch, rangeIndex: number) => void)
    | undefined
  onDismissFile?: ((resource: URI) => void) | undefined
  replaceVisible?: boolean
  /** Replacement text, for the inline old→new diff preview on match rows. */
  replacePattern?: string
  /** Shift+Tab on the results tree — hand focus back to the search input. */
  onShiftTab?: (() => void) | undefined
}

export interface SearchResultsTreeHandle {
  /** Focus the topmost visible node (used for Tab from the search input). */
  focusFirst(): void
  /**
   * Focus the node for `resource`: the match node `preferMatchId` when it still
   * exists under that file, otherwise the file node. Returns false when the
   * file is not in the current results.
   */
  focusResource(resource: URI, preferMatchId: string | null): boolean
}

function highlight(
  preview: string,
  range: { startColumn: number; endColumn: number } | undefined,
  replaceText: string | null,
) {
  if (!range) return preview
  const start = Math.max(range.startColumn - 1, 0)
  const end = Math.max(range.endColumn - 1, start)
  const matched = preview.slice(start, end)
  return [
    preview.slice(0, start),
    replaceText !== null ? (
      <span key="r" className={styles['matchReplace']}>
        <span className={styles['matchRemove']}>{matched}</span>
        <span className={styles['matchInsert']}>{replaceText}</span>
      </span>
    ) : (
      <span key="m" className={styles['match']}>
        {matched}
      </span>
    ),
    preview.slice(end),
  ]
}

export const SearchResultsTree = forwardRef<SearchResultsTreeHandle, SearchResultsTreeProps>(
  function SearchResultsTree(
    {
      results,
      rootUri = null,
      onActivateMatch,
      onReplaceFile,
      onReplaceMatch,
      onDismissMatch,
      onDismissFile,
      replaceVisible,
      replacePattern = '',
      onShiftTab,
    },
    handleRef,
  ) {
    const viewMode = useObservable(searchViewState.viewMode)
    const [menu, setMenu] = useState<SearchContextMenuState | null>(null)

    // Soft dependency: the tree renders fine without a container (it takes all
    // its data through props), so an absent configuration service just means the
    // VSCode-default `alwaysExpand`.
    const configurationService = useOptionalService(IConfigurationService)
    const [collapseMode, setCollapseMode] = useState<CollapseResults>(
      () =>
        configurationService?.get<CollapseResults>('search.collapseResults', 'alwaysExpand') ??
        'alwaysExpand',
    )
    // The model is created once and `defaultExpanded` is called long after
    // render, so the current mode is also kept in a ref for it to read.
    const collapseModeRef = useRef<CollapseResults>(collapseMode)
    collapseModeRef.current = collapseMode

    useEffect(() => {
      if (!configurationService) return
      const d = markAsSingleton(
        configurationService.onDidChangeConfiguration((e) => {
          if (!e.affectsConfiguration('search.collapseResults')) return
          setCollapseMode(
            configurationService.get<CollapseResults>('search.collapseResults', 'alwaysExpand') ??
              'alwaysExpand',
          )
        }),
      )
      return () => d.dispose()
    }, [configurationService])

    const containerRef = useRef<HTMLDivElement | null>(null)
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
        defaultExpanded: (n) => resolveExpanded(n, collapseModeRef.current),
      })
    })

    // Feeding the previous build back in lets unchanged files keep their node
    // objects, so a streamed batch costs O(changed matches) instead of O(all).
    const prevBuildRef = useRef<SearchBuildContext | undefined>(undefined)
    const snapshot = useMemo(() => {
      const next = recordPerfPhase('search.buildSnapshot', () =>
        buildSearchSnapshot(results, rootUri, viewMode, prevBuildRef.current),
      )
      prevBuildRef.current = { rootUri, mode: viewMode, snapshot: next }
      return next
    }, [results, rootUri, viewMode])
    snapshotRef.current = snapshot

    // id → node lookup, built as part of the snapshot for imperative focus targeting.
    const nodeByIdRef = useRef(snapshot.nodeById)
    nodeByIdRef.current = snapshot.nodeById

    // Selected file URIs (deduped), read lazily at dragstart so a multi-selection
    // drags all of them. A match contributes its file; folders are skipped.
    const getSelectedUris = useCallback((): string[] => {
      const ids = new Set(model.selection)
      const seen = new Set<string>()
      for (const n of nodeByIdRef.current.values()) {
        if (!ids.has(n.id)) continue
        if (n.kind === 'file' || n.kind === 'match') seen.add(n.resource.toString())
      }
      return [...seen]
    }, [model])

    useImperativeHandle(
      handleRef,
      () => ({
        focusFirst() {
          const first = model.getVisibleNodes()[0]
          if (!first) return
          model.setSelection([first.id], first.id)
          containerRef.current?.focus()
        },
        focusResource(resource, preferMatchId) {
          const fileId = `file:${resource.toString()}`
          const map = nodeByIdRef.current
          if (!map.has(fileId)) return false
          const parentMap = snapshotRef.current.parentMap
          const useMatch =
            preferMatchId != null &&
            map.has(preferMatchId) &&
            parentMap.get(preferMatchId)?.id === fileId
          const targetId = useMatch ? (preferMatchId as string) : fileId
          // Expand the ancestor chain so the target is visible (folders in tree
          // mode, the file node when the match is a leaf below it).
          const toExpand: (readonly [string, boolean])[] = []
          let parent = parentMap.get(targetId)
          while (parent) {
            toExpand.push([parent.id, true] as const)
            parent = parentMap.get(parent.id)
          }
          if (toExpand.length > 0) model.setExpansion(toExpand)
          model.setSelection([targetId], targetId)
          containerRef.current?.focus()
          return true
        },
      }),
      [model],
    )

    useLayoutEffect(() => {
      // Seed newly-seen expandable nodes, respecting any saved collapsed state from
      // a prior mount so switching views and back preserves user collapses. One
      // combined call: seeding and the post-data refresh would otherwise fire two
      // structure events per streamed batch, recomputing every visible row twice.
      const toSeed: (readonly [string, boolean])[] = []
      for (const id of snapshot.expandableIds) {
        if (model.hasState(id)) continue
        const node = snapshot.nodeById.get(id)
        if (node) toSeed.push([id, resolveExpanded(node, collapseModeRef.current)] as const)
      }
      recordPerfPhase('search.seedExpansion', () => model.setExpansionAndRefresh(toSeed))
    }, [snapshot, model])

    // Switching search.collapseResults re-applies the new policy to nodes that
    // are already rendered (VSCode does the same), leaving hand-set nodes alone.
    const appliedModeRef = useRef(collapseMode)
    useLayoutEffect(() => {
      if (appliedModeRef.current === collapseMode) return
      appliedModeRef.current = collapseMode
      const updates: (readonly [string, boolean])[] = []
      for (const id of snapshotRef.current.expandableIds) {
        const node = snapshotRef.current.nodeById.get(id)
        if (!node) continue
        updates.push([id, resolveExpanded(node, collapseMode)] as const)
      }
      model.setExpansionAndRefresh(updates)
    }, [collapseMode, model])

    // Collapse-all driven from the title toolbar via a shared signal counter.
    const collapseSignal = useObservable(searchViewState.collapseAllSignal)
    const seenCollapse = useRef(collapseSignal)
    useEffect(() => {
      if (collapseSignal === seenCollapse.current) return
      seenCollapse.current = collapseSignal
      model.setExpansion(snapshotRef.current.expandableIds.map((id) => [id, false] as const))
    }, [collapseSignal, model])

    // Persist expansion deviations to searchSession so switching views and back
    // restores them. Only nodes whose state differs from what the current
    // collapseResults policy would pick are recorded, so an auto-collapsed file
    // is not later mistaken for a deliberate one.
    useEffect(() => {
      const d = markAsSingleton(
        model.onDidChangeStructure(() => {
          const overrides = new Map<string, boolean>()
          for (const id of snapshotRef.current.expandableIds) {
            if (!model.hasState(id)) continue
            const node = snapshotRef.current.nodeById.get(id)
            if (!node) continue
            const expanded = model.isExpanded(id)
            // A node back at its policy default stops being an override.
            if (expanded !== policyExpanded(node, collapseModeRef.current)) {
              overrides.set(id, expanded)
            }
          }
          searchSession.treeExpansionOverrides = overrides
        }),
      )
      return () => d.dispose()
    }, [model])

    const dismissNode = (n: SearchNode): void => {
      if (n.kind === 'match') onDismissMatch?.(n.resource, n.match, n.rangeIndex)
      else if (n.kind === 'file') onDismissFile?.(n.resource)
    }

    const openRowMenu = (e: ReactMouseEvent, n: SearchNode): void => {
      e.preventDefault()
      e.stopPropagation()
      const items: SearchMenuItem[] = []
      if (n.kind === 'match') {
        items.push({
          label: localize('search.menu.copy', 'Copy'),
          run: () => void navigator.clipboard?.writeText(n.match.preview.trim()),
        })
        if (onDismissMatch)
          items.push({ label: localize('search.menu.remove', 'Remove'), run: () => dismissNode(n) })
      } else if (n.kind === 'file') {
        items.push({
          label: localize('search.menu.copyPath', 'Copy Path'),
          run: () => void navigator.clipboard?.writeText(resourceDisplayPath(n.resource)),
        })
        items.push({
          label: localize('search.menu.copyAll', 'Copy All'),
          run: () =>
            void navigator.clipboard?.writeText(
              n.fileMatch.matches.map((m) => m.preview.trim()).join('\n'),
            ),
        })
        if (onDismissFile)
          items.push({ label: localize('search.menu.remove', 'Remove'), run: () => dismissNode(n) })
      } else {
        items.push({
          label: localize('search.menu.copyPath', 'Copy Path'),
          run: () => void navigator.clipboard?.writeText(n.relPath),
        })
      }
      if (items.length > 0) setMenu({ x: e.clientX, y: e.clientY, items })
    }

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
            data-tooltip={n.relPath}
            onClick={ctx.onClickRow}
            onContextMenu={(e) => openRowMenu(e, n)}
          >
            <button
              type="button"
              className={styles['chevron']}
              aria-label={localize('search.toggleNode', 'Toggle {name}', { name: n.name })}
              onClick={(e) => {
                e.stopPropagation()
                ctx.onToggle()
              }}
            >
              {ctx.node.expanded ? (
                <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
            <span className={styles['rowIcon']} aria-hidden="true">
              {ctx.node.expanded ? (
                <FolderOpen size={14} strokeWidth={1.75} />
              ) : (
                <Folder size={14} strokeWidth={1.75} />
              )}
            </span>
            <span className={styles['rowLabel']}>{n.name}</span>
            <span
              className={styles['fileCount']}
              aria-label={localize('search.matchCount', '{count} matches', {
                count: n.matchCount,
              })}
            >
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
            data-tooltip={n.relPath}
            onClick={ctx.onClickRow}
            onContextMenu={(e) => openRowMenu(e, n)}
            {...resourceDragProps(() =>
              selectionDragUris(n.resource.toString(), getSelectedUris()),
            )}
          >
            <button
              type="button"
              className={styles['chevron']}
              aria-label={localize('search.toggleNode', 'Toggle {name}', { name: n.name })}
              onClick={(e) => {
                e.stopPropagation()
                ctx.onToggle()
              }}
            >
              {ctx.node.expanded ? (
                <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
              )}
            </button>
            <FileIcon
              resource={n.resource}
              isDirectory={false}
              className={styles['rowIcon']}
              size={14}
            />
            <span className={styles['rowLabel']}>
              {n.name}
              {viewMode === 'list' && n.dirPath.length > 0 && (
                <span className={styles['fileDir']}>{n.dirPath}</span>
              )}
            </span>
            <span
              className={styles['fileCount']}
              aria-label={localize('search.matchCount', '{count} matches', {
                count: n.matchCount,
              })}
            >
              {n.matchCount}
            </span>
            {replaceVisible && onReplaceFile && (
              <button
                type="button"
                className={styles['replaceBtn']}
                data-tooltip={localize('search.replaceAllInFile', 'Replace All in File')}
                aria-label={localize('search.replaceAllInNamedFile', 'Replace all in {name}', {
                  name: n.name,
                })}
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
      const replaceText = replaceVisible && replacePattern.length > 0 ? replacePattern : null
      return (
        <div
          key={n.id}
          data-row-key={n.id}
          role="treeitem"
          className={className}
          style={style}
          data-tooltip={n.match.preview}
          onClick={ctx.onClickRow}
          onDoubleClick={() => onActivateMatch(n.resource, n.match, n.rangeIndex, false)}
          onContextMenu={(e) => openRowMenu(e, n)}
          {...resourceDragProps(() => selectionDragUris(n.resource.toString(), getSelectedUris()))}
        >
          <span className={styles['lineNumber']}>{n.match.lineNumber}</span>
          <span className={styles['matchPreview']}>
            {highlight(n.match.preview, range, replaceText)}
          </span>
          {replaceVisible && onReplaceMatch && (
            <button
              type="button"
              className={styles['replaceBtn']}
              data-tooltip={localize('search.replace', 'Replace')}
              aria-label={localize('search.replaceMatchAtLine', 'Replace match at line {line}', {
                line: n.match.lineNumber,
              })}
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
      <>
        <Tree<SearchNode>
          model={model}
          rootRef={containerRef}
          scrollStateKey="search"
          className={styles['resultsTree'] ?? ''}
          ariaLabel={localize('search.results', 'Search results')}
          rowHeight={22}
          indentWidth={10}
          renderRow={renderRow}
          {...(onShiftTab ? { onShiftTab } : {})}
          onActivate={(node, opts) => {
            const n = node.element
            if (n.kind === 'match') {
              searchSession.lastActivatedResource = n.resource.toString()
              searchSession.lastActivatedFocusId = n.id
              onActivateMatch(n.resource, n.match, n.rangeIndex, opts.preview)
            }
          }}
          onRowKeyDown={(e, node) => {
            if (e.key === 'Delete') {
              e.preventDefault()
              dismissNode(node.element)
            }
          }}
          onContextMenu={(e, node) => {
            if (node) openRowMenu(e, node.element)
          }}
        />
        {menu && <SearchResultsContextMenu state={menu} onClose={() => setMenu(null)} />}
      </>
    )
  },
)
