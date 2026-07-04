/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineView — sidebar tree of the active editor's document symbols. Data comes
 *  from IOutlineService (which pulls from the language features facade); the
 *  generic <Tree> handles virtualization / keyboard nav. Clicking a row jumps to
 *  the symbol; the symbol under the cursor is highlighted (follow-cursor).
 *
 *  Title-bar driven behaviour (state in outlineViewState):
 *   - Sort By Position / Name / Category — re-sorts each level before building.
 *   - Collapse All / Expand All — driven by monotonic signals from the toolbar.
 *   - Follow Cursor — when on, the symbol under the caret is expanded-to,
 *     selected and scrolled into view (when off it is only highlighted).
 *   - Filter on Type — typing in the focused tree opens a find box; on it prunes
 *     the tree to matches + ancestors, off it highlights matches in place.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { localize } from '@universe-editor/platform'
import {
  Tree,
  TreeModel,
  useOwnedTreeModel,
  type ITreeDataSource,
} from '@universe-editor/workbench-ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useService, useObservable } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import { type monaco } from '../editor/monaco/MonacoLoader.js'
import { IOutlineService } from '../../services/languageFeatures/OutlineService.js'
import { SymbolIcon } from '../symbols/symbolIcon.js'
import { outlineViewState, type OutlineSortOrder } from './outlineViewState.js'
import { OutlineNavigatorRegistry } from './outlineNavigatorRegistry.js'
import styles from './OutlineView.module.css'

interface OutlineNode {
  readonly id: string
  readonly symbol: monaco.languages.DocumentSymbol
  readonly children: OutlineNode[]
}

interface DisplayOutline {
  readonly roots: OutlineNode[]
  readonly idBySymbol: Map<monaco.languages.DocumentSymbol, string>
  readonly matchedIds: Set<string>
  /** Ids whose expansion must be forced to true after a refresh (filter/highlight). */
  readonly expandToIds: string[]
}

function comparePosition(
  a: monaco.languages.DocumentSymbol,
  b: monaco.languages.DocumentSymbol,
): number {
  return (
    a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn
  )
}

function compareSymbols(
  a: monaco.languages.DocumentSymbol,
  b: monaco.languages.DocumentSymbol,
  order: OutlineSortOrder,
): number {
  if (order === 'name') return a.name.localeCompare(b.name) || comparePosition(a, b)
  if (order === 'kind') return a.kind - b.kind || a.name.localeCompare(b.name)
  return comparePosition(a, b)
}

function buildNodes(
  roots: readonly monaco.languages.DocumentSymbol[],
  order: OutlineSortOrder,
): { roots: OutlineNode[]; idBySymbol: Map<monaco.languages.DocumentSymbol, string> } {
  const idBySymbol = new Map<monaco.languages.DocumentSymbol, string>()
  const build = (
    symbols: readonly monaco.languages.DocumentSymbol[],
    prefix: string,
  ): OutlineNode[] =>
    [...symbols]
      .sort((a, b) => compareSymbols(a, b, order))
      .map((symbol, i) => {
        const id = prefix === '' ? `${i}` : `${prefix}/${i}`
        idBySymbol.set(symbol, id)
        return { id, symbol, children: build(symbol.children ?? [], id) }
      })
  return { roots: build(roots, ''), idBySymbol }
}

function ancestorIds(id: string): string[] {
  const parts = id.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

function collectExpandableIds(nodes: readonly OutlineNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length > 0) {
      acc.push(n.id)
      collectExpandableIds(n.children, acc)
    }
  }
  return acc
}

/** Flatten the tree into an id → node map (for the parent-link lookup). */
function indexById(
  nodes: readonly OutlineNode[],
  acc: Map<string, OutlineNode> = new Map(),
): Map<string, OutlineNode> {
  for (const n of nodes) {
    acc.set(n.id, n)
    indexById(n.children, acc)
  }
  return acc
}

/** Prune the tree to nodes that match `q` or have a matching descendant. */
function pruneTree(nodes: readonly OutlineNode[], q: string): OutlineNode[] {
  const out: OutlineNode[] = []
  for (const n of nodes) {
    const children = pruneTree(n.children, q)
    if (n.symbol.name.toLowerCase().includes(q) || children.length > 0) {
      out.push({ id: n.id, symbol: n.symbol, children })
    }
  }
  return out
}

/** Collect ids of every node whose name matches `q`. */
function collectMatchedIds(
  nodes: readonly OutlineNode[],
  q: string,
  acc: Set<string> = new Set(),
): Set<string> {
  for (const n of nodes) {
    if (n.symbol.name.toLowerCase().includes(q)) acc.add(n.id)
    collectMatchedIds(n.children, q, acc)
  }
  return acc
}

export function OutlineView() {
  const outlineService = useService(IOutlineService)
  const outline = useObservable(outlineService.outline)
  const activeSymbol = useObservable(outlineService.activeSymbol)
  const sortBy = useObservable(outlineViewState.sortBy)
  const followCursor = useObservable(outlineViewState.followCursor)
  const filterOnType = useObservable(outlineViewState.filterOnType)
  const collapseSignal = useObservable(outlineViewState.collapseAllSignal)
  const expandSignal = useObservable(outlineViewState.expandAllSignal)

  const [findActive, setFindActive] = useState(false)
  const [filterText, setFilterText] = useState('')
  const query = filterText.trim().toLowerCase()

  const containerRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const rootsRef = useRef<OutlineNode[]>([])
  const nodeByIdRef = useRef<Map<string, OutlineNode>>(new Map())
  const idBySymbolRef = useRef<Map<monaco.languages.DocumentSymbol, string>>(new Map())
  const activeIdRef = useRef<string | undefined>(undefined)

  const model = useOwnedTreeModel<OutlineNode>(() => {
    const dataSource: ITreeDataSource<OutlineNode> = {
      getId: (n) => n.id,
      hasChildren: (n) => n.children.length > 0,
      getChildren: (n) => n.children,
      getRoots: () => rootsRef.current,
      // Node ids encode the path ("0/1/2"); the parent id drops the last segment.
      // Enables ArrowLeft "go to parent" from a leaf, matching the Explorer tree.
      getParent: (n) => {
        const slash = n.id.lastIndexOf('/')
        if (slash < 0) return null
        return nodeByIdRef.current.get(n.id.slice(0, slash)) ?? null
      },
    }
    return new TreeModel<OutlineNode>({ dataSource, defaultExpanded: () => true })
  })

  useViewFocusable(
    'workbench.view.outline.main',
    useCallback(() => containerRef.current, []),
  )

  // Expose the tree's arrow-navigation to the emacs Ctrl+P/N/B/F commands, which
  // the global keybinding handler claims before the keys can reach the tree.
  useEffect(() => {
    const d = OutlineNavigatorRegistry.register({
      navigate: (direction) => model.navigate(direction),
    })
    return () => d.dispose()
  }, [model])

  // Build the display tree: sort, then (when filtering) prune to matches +
  // ancestors or collect the matches to highlight in place.
  const display = useMemo<DisplayOutline>(() => {
    const built = buildNodes(outline?.roots ?? [], sortBy)
    if (query === '') {
      return {
        roots: built.roots,
        idBySymbol: built.idBySymbol,
        matchedIds: new Set(),
        expandToIds: [],
      }
    }
    const matchedIds = collectMatchedIds(built.roots, query)
    if (filterOnType) {
      const pruned = pruneTree(built.roots, query)
      return {
        roots: pruned,
        idBySymbol: built.idBySymbol,
        matchedIds,
        expandToIds: collectExpandableIds(pruned),
      }
    }
    // Highlight mode: keep the full tree, expand ancestors of every match.
    const expand = new Set<string>()
    for (const id of matchedIds) for (const a of ancestorIds(id)) expand.add(a)
    return {
      roots: built.roots,
      idBySymbol: built.idBySymbol,
      matchedIds,
      expandToIds: [...expand],
    }
  }, [outline, sortBy, query, filterOnType])

  // Apply the freshly built tree to the model, then force any required expansion.
  useEffect(() => {
    rootsRef.current = display.roots
    nodeByIdRef.current = indexById(display.roots)
    idBySymbolRef.current = display.idBySymbol
    model.refresh()
    if (display.expandToIds.length > 0) {
      model.setExpansion(display.expandToIds.map((id) => [id, true] as const))
    }
  }, [display, model])

  // Keep outlineViewState.allCollapsed in sync so the toolbar icon flips. A node
  // counts as "collapsed" only when an expandable visible row is not expanded;
  // reading the visible nodes also materialises default-expanded state.
  useEffect(() => {
    const update = (): void => {
      const visible = model.getVisibleNodes()
      const expandable = visible.filter((n) => n.hasChildren)
      const allCollapsed = expandable.length > 0 && expandable.every((n) => !n.expanded)
      outlineViewState.setAllCollapsed(allCollapsed)
    }
    update()
    const d = model.onDidChangeStructure(update)
    return () => d.dispose()
  }, [model])

  // Collapse-all / expand-all signals from the toolbar (skip the mount value).
  const lastCollapse = useRef(collapseSignal)
  useEffect(() => {
    if (collapseSignal === lastCollapse.current) return
    lastCollapse.current = collapseSignal
    model.collapseAll()
  }, [collapseSignal, model])

  const lastExpand = useRef(expandSignal)
  useEffect(() => {
    if (expandSignal === lastExpand.current) return
    lastExpand.current = expandSignal
    model.setExpansion(collectExpandableIds(rootsRef.current).map((id) => [id, true] as const))
  }, [expandSignal, model])

  // When the tree gains focus without a (still-visible) focused row — e.g. via
  // the `outline.focus` command, or after a document switch left a stale focus —
  // select the symbol under the editor cursor, falling back to the first row, so
  // keyboard navigation is usable immediately, VSCode-style. Driven by the Tree's
  // onFocus prop rather than a manual listener so it also fires when symbols
  // arrive after the tree first mounted empty (cold language-server start).
  const onTreeFocus = useCallback(() => {
    const visible = model.getVisibleNodes()
    const focusedId = model.focused
    if (focusedId != null && visible.some((n) => n.id === focusedId)) return
    const targetId = activeIdRef.current ?? visible[0]?.id
    if (targetId != null) model.setSelection([targetId], targetId)
  }, [model])

  const activeId = activeSymbol ? display.idBySymbol.get(activeSymbol) : undefined
  activeIdRef.current = activeId

  // Follow cursor: expand to + select + scroll the active symbol into view.
  useEffect(() => {
    if (!followCursor || query !== '' || !activeId) return
    const ancestors = ancestorIds(activeId)
    if (ancestors.length > 0) model.setExpansion(ancestors.map((id) => [id, true] as const))
    model.setSelection([activeId], activeId)
  }, [followCursor, query, activeId, model])

  // Focus the find box as it opens.
  useEffect(() => {
    if (findActive) findInputRef.current?.focus()
  }, [findActive])

  const closeFind = useCallback(() => {
    setFindActive(false)
    setFilterText('')
    containerRef.current?.focus()
  }, [])

  // Type-to-filter: a printable key in the focused tree opens the find box.
  const onWrapperKeyDownCapture = useCallback(
    (e: ReactKeyboardEvent) => {
      if (findActive || e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key.length === 1 && e.key !== ' ') {
        setFindActive(true)
        setFilterText(e.key)
        e.preventDefault()
        e.stopPropagation()
      }
    },
    [findActive],
  )

  if (!outline || outline.roots.length === 0) {
    return <div className={styles['empty']}>{localize('outline.empty', 'No symbols found.')}</div>
  }

  const hasResults = display.roots.length > 0

  return (
    <div className={styles['wrapper']} onKeyDownCapture={onWrapperKeyDownCapture}>
      {findActive && (
        <div className={styles['findWidget']}>
          <input
            ref={findInputRef}
            type="text"
            className={styles['findInput']}
            placeholder={localize('outline.filterPlaceholder', 'Filter')}
            value={filterText}
            spellCheck={false}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
          />
        </div>
      )}
      {hasResults ? (
        <Tree<OutlineNode>
          model={model}
          rootRef={containerRef}
          className={styles['view'] ?? ''}
          virtualListClassName={styles['virtualList'] ?? ''}
          ariaLabel={localize('outline.label', 'Outline')}
          renderRow={(ctx) => {
            const node = ctx.node
            const isMatch = display.matchedIds.has(node.id)
            const isDim = query !== '' && !filterOnType && !isMatch
            const className = [
              styles['row'],
              node.id === activeId && styles['active'],
              ctx.isSelected && styles['selected'],
              ctx.isFocused && styles['focused'],
              isMatch && styles['match'],
              isDim && styles['dim'],
            ]
              .filter(Boolean)
              .join(' ')
            const onClick = (e: ReactMouseEvent) => {
              ctx.onClickRow(e)
              outlineService.revealSymbol(node.element.symbol)
            }
            return (
              <div
                key={node.id}
                data-row-key={node.id}
                role="treeitem"
                aria-expanded={node.hasChildren ? node.expanded : undefined}
                aria-selected={ctx.isSelected}
                className={className}
                style={
                  ctx.style
                    ? { paddingLeft: ctx.indentPadding, ...ctx.style }
                    : { paddingLeft: ctx.indentPadding }
                }
                onClick={onClick}
              >
                <span
                  className={styles['chevron']}
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation()
                    ctx.onToggle()
                  }}
                >
                  {node.hasChildren &&
                    (node.expanded ? (
                      <ChevronDown size={16} strokeWidth={1.75} />
                    ) : (
                      <ChevronRight size={16} strokeWidth={1.75} />
                    ))}
                </span>
                <span className={styles['icon']} aria-hidden="true">
                  <SymbolIcon
                    kind={node.element.symbol.kind}
                    languageId={outline.languageId}
                    size={14}
                  />
                </span>
                <span className={styles['label']}>{node.element.symbol.name}</span>
              </div>
            )
          }}
          onActivate={(node) => outlineService.revealSymbol(node.element.symbol)}
          onFocus={onTreeFocus}
          activateNonLeafOnEnter
        />
      ) : (
        <div className={styles['empty']}>
          {localize('outline.noMatches', 'No matching symbols.')}
        </div>
      )}
    </div>
  )
}
