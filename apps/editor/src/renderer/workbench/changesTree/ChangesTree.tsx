/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ChangesTree — the shared interaction core of the changed-files views
 *  (Commit Changes, Session Changes): TreeModel + workbench-ui <Tree> rendering
 *  with keyboard navigation, view-level collapse state, collapse/expand-all
 *  signals, reveal, focus landing/memory and shift/ctrl selection. What a row
 *  shows (icon, rename prefix, badges, hover actions) and what activating it
 *  does are injected by the owning view via `describeFile` and the activate
 *  callbacks, so provider-specific behaviour never leaks in here.
 *--------------------------------------------------------------------------------------------*/

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { URI, type IObservable } from '@universe-editor/platform'
import {
  resourceDragProps,
  Tree,
  TreeModel,
  useOwnedTreeModel,
  type ITreeDataSource,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { FileIcon } from '../files/fileIconTheme.js'
import { useObservable } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import {
  buildChangesTreeSnapshot,
  findChangesTreeFileNode,
  type ChangesTreeItem,
  type ChangesTreeNode,
  type ChangesTreeSnapshot,
  type ChangesTreeViewMode,
} from './buildSnapshot.js'
import styles from './ChangesTree.module.css'

/** Per-row presentation, produced by the owning view from its entry type. */
export interface ChangesTreeFileDisplay {
  readonly iconUri: URI
  readonly label: string
  readonly tooltip: string
  /** Rendered before the label (e.g. the rename "old →" prefix). */
  readonly labelPrefix?: ReactNode
  /** Rendered after the label (e.g. the inferred badge). */
  readonly labelSuffix?: ReactNode
  /** Hover action buttons; each handles its own stopPropagation. */
  readonly actions?: ReactNode
  /** Trailing status letter / badge span. */
  readonly statusBadge?: ReactNode
  readonly rowTestId?: string | undefined
  /** data-status on the row root — drives the label tint CSS. */
  readonly rowDataStatus?: string | undefined
  readonly dragUris?: readonly string[] | undefined
}

export interface ChangesTreeFocusMemory {
  remember(path: string): void
  recall(): string | undefined
}

export interface ChangesTreeProps<TEntry> {
  readonly items: readonly ChangesTreeItem<TEntry>[]
  readonly viewMode: ChangesTreeViewMode
  /** Registered with FocusableRegistry so LayoutService.focusView lands here. */
  readonly viewId: string
  readonly ariaLabel: string
  /** Monotonic counters from the title toolbar (a separate React subtree). */
  readonly collapseAllSignal: IObservable<number>
  readonly expandAllSignal: IObservable<number>
  readonly describeFile: (entry: TEntry) => ChangesTreeFileDisplay
  /** Keyboard activation: Space = preview (keep tree focus), Enter = open. */
  readonly onActivateFile: (entry: TEntry, opts: { readonly preview: boolean }) => void
  /** Plain mouse click / double click; default to onActivateFile preview true/false. */
  readonly onFileClick?: ((entry: TEntry) => void) | undefined
  readonly onFileDoubleClick?: ((entry: TEntry) => void) | undefined
  readonly revealPath?: string | undefined
  readonly focusMemory?: ChangesTreeFocusMemory | undefined
  readonly scrollStateKey?: string | undefined
  readonly folderTestId?: string | undefined
  /** Rendered above the tree, inside the padded content column. */
  readonly header?: ReactNode
}

function rowClassName(base: string, isSelected: boolean, isFocused: boolean): string {
  return [base, isSelected && styles['selected'], isFocused && styles['focused']]
    .filter(Boolean)
    .join(' ')
}

/** Plain click selects and runs `onPlain`; shift/ctrl follow the shared tree
 *  selection semantics (same helper shape as ScmView's rows). */
function rowClick<TEntry>(
  model: TreeModel<ChangesTreeNode<TEntry>>,
  node: ChangesTreeNode<TEntry>,
  e: ReactMouseEvent,
  onPlain: () => void,
): void {
  if (e.shiftKey) {
    e.preventDefault()
    model.selectRange(model.focused ?? node.id, node.id)
    return
  }
  if (e.ctrlKey || e.metaKey) {
    model.toggleInSelection(node.id)
    return
  }
  model.setSelection([node.id], node.id)
  onPlain()
}

interface SharedRowProps<TEntry> {
  model: TreeModel<ChangesTreeNode<TEntry>>
  indentPadding: number
  isSelected: boolean
  isFocused: boolean
  /** Virtualization positioning style from <Tree>; merged onto the row root. */
  rowStyle?: CSSProperties
}

function FileRowInner<TEntry>({
  model,
  node,
  indentPadding,
  isSelected,
  isFocused,
  rowStyle,
  describeFile,
  onPlain,
  onDouble,
}: SharedRowProps<TEntry> & {
  node: Extract<ChangesTreeNode<TEntry>, { kind: 'file' }>
  describeFile: (entry: TEntry) => ChangesTreeFileDisplay
  onPlain: (entry: TEntry) => void
  onDouble: (entry: TEntry) => void
}) {
  const entry = node.item.entry
  const display = describeFile(entry)
  const dragUris = display.dragUris
  return (
    <li
      data-row-key={node.id}
      role="treeitem"
      aria-selected={isSelected}
      className={rowClassName(styles['file'] ?? '', isSelected, isFocused)}
      style={
        rowStyle ? { paddingLeft: indentPadding, ...rowStyle } : { paddingLeft: indentPadding }
      }
      data-tooltip={display.tooltip}
      {...(display.rowTestId !== undefined ? { 'data-testid': display.rowTestId } : {})}
      {...(display.rowDataStatus !== undefined ? { 'data-status': display.rowDataStatus } : {})}
      {...(dragUris !== undefined ? resourceDragProps(() => dragUris) : {})}
      onClick={(e) => rowClick(model, node, e, () => onPlain(entry))}
      onDoubleClick={() => onDouble(entry)}
    >
      <FileIcon
        resource={display.iconUri}
        className={styles['fileIcon']}
        isDirectory={false}
        size={16}
      />
      {display.labelPrefix}
      <span className={styles['fileLabel']}>{display.label}</span>
      {display.labelSuffix}
      {node.dir ? <span className={styles['fileDir']}>{node.dir}</span> : null}
      <span className={styles['fileActions']}>{display.actions}</span>
      {display.statusBadge}
    </li>
  )
}
const FileRow = memo(FileRowInner) as typeof FileRowInner

function FolderRowInner<TEntry>({
  model,
  node,
  indentPadding,
  isSelected,
  isFocused,
  expanded,
  onToggle,
  rowStyle,
  testId,
}: SharedRowProps<TEntry> & {
  node: Extract<ChangesTreeNode<TEntry>, { kind: 'folder' }>
  expanded: boolean
  onToggle: (node: Extract<ChangesTreeNode<TEntry>, { kind: 'folder' }>) => void
  testId?: string | undefined
}) {
  const folderUri = useMemo(() => URI.file(node.name), [node.name])
  return (
    <li
      data-row-key={node.id}
      role="treeitem"
      aria-expanded={expanded}
      aria-selected={isSelected}
      className={rowClassName(styles['folder'] ?? '', isSelected, isFocused)}
      style={
        rowStyle ? { paddingLeft: indentPadding, ...rowStyle } : { paddingLeft: indentPadding }
      }
      data-tooltip={node.path}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
      onClick={(e) => rowClick(model, node, e, () => onToggle(node))}
    >
      {expanded ? (
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          className={styles['chevron']}
          aria-hidden="true"
        />
      ) : (
        <ChevronRight
          size={16}
          strokeWidth={1.75}
          className={styles['chevron']}
          aria-hidden="true"
        />
      )}
      <FileIcon
        resource={folderUri}
        className={styles['fileIcon']}
        isDirectory
        expanded={expanded}
        size={16}
      />
      <span className={styles['folderLabel']}>{node.name}</span>
    </li>
  )
}
const FolderRow = memo(FolderRowInner) as typeof FolderRowInner

export function ChangesTree<TEntry>({
  items,
  viewMode,
  viewId,
  ariaLabel,
  collapseAllSignal,
  expandAllSignal,
  describeFile,
  onActivateFile,
  onFileClick,
  onFileDoubleClick,
  revealPath,
  focusMemory,
  scrollStateKey,
  folderTestId,
  header,
}: ChangesTreeProps<TEntry>) {
  // Collapse state lives outside the TreeModel: the snapshot drops a collapsed
  // folder's children outright, so a row click just edits this set and the
  // rebuilt snapshot re-renders the tree.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed

  const itemsRef = useRef(items)
  itemsRef.current = items
  const revealPathRef = useRef(revealPath)
  revealPathRef.current = revealPath

  // Latest-callback trampolines so the memoized rows keep stable props even if
  // the owning view passes fresh closures each render.
  const callbacksRef = useRef({
    describeFile,
    onActivateFile,
    onFileClick,
    onFileDoubleClick,
    focusMemory,
  })
  callbacksRef.current = {
    describeFile,
    onActivateFile,
    onFileClick,
    onFileDoubleClick,
    focusMemory,
  }
  const stableDescribe = useCallback(
    (entry: TEntry) => callbacksRef.current.describeFile(entry),
    [],
  )
  const handlePlainClick = useCallback((entry: TEntry) => {
    const { onFileClick: click, onActivateFile: activate } = callbacksRef.current
    if (click) click(entry)
    else activate(entry, { preview: true })
  }, [])
  const handleDoubleClick = useCallback((entry: TEntry) => {
    const { onFileDoubleClick: dbl, onActivateFile: activate } = callbacksRef.current
    if (dbl) dbl(entry)
    else activate(entry, { preview: false })
  }, [])

  const snapshotRef = useRef<ChangesTreeSnapshot<TEntry>>({
    roots: [],
    childrenMap: new Map(),
    parentMap: new Map(),
  })
  const treeModel = useOwnedTreeModel<ChangesTreeNode<TEntry>>(() => {
    const dataSource: ITreeDataSource<ChangesTreeNode<TEntry>> = {
      getId: (n) => n.id,
      hasChildren: (n) => (snapshotRef.current.childrenMap.get(n.id)?.length ?? 0) > 0,
      getChildren: (n) => snapshotRef.current.childrenMap.get(n.id) ?? [],
      getRoots: () => snapshotRef.current.roots,
      getParent: (n) => snapshotRef.current.parentMap.get(n.id) ?? null,
    }
    return new TreeModel<ChangesTreeNode<TEntry>>({
      dataSource,
      defaultExpanded: (n) => n.kind === 'folder',
    })
  })

  const snapshot = useMemo(
    () => buildChangesTreeSnapshot(items, collapsed, viewMode),
    [items, collapsed, viewMode],
  )
  snapshotRef.current = snapshot
  useLayoutEffect(() => {
    treeModel.refresh()
  }, [snapshot, treeModel])

  // The tree container is the view's focus target (LayoutService.focusView
  // resolves it through FocusableRegistry); onFocus below then picks the row.
  const treeRef = useRef<HTMLDivElement>(null)
  useViewFocusable(
    viewId,
    useCallback(() => treeRef.current, []),
  )

  // Remember the focused file so a remount (fresh TreeModel) can restore it
  // when the view regains focus.
  useEffect(() => {
    const d = treeModel.onDidChangeSelection(() => {
      const focusedId = treeModel.focused
      if (!focusedId) return
      const node = treeModel.getVisibleNodes().find((n) => n.id === focusedId)
      if (node?.element.kind === 'file') {
        callbacksRef.current.focusMemory?.remember(node.element.item.path)
      }
    })
    return () => d.dispose()
  }, [treeModel])

  // Collapse/expand-all are driven from the title toolbar via shared signal
  // counters; each increment past the value seen at mount applies the request.
  // Collapse-all collects every folder path from a fully-expanded tree
  // snapshot (compaction-aware: the collapsed set is keyed by leaf path).
  const collapseSignal = useObservable(collapseAllSignal)
  const expandSignal = useObservable(expandAllSignal)
  const seenSignalsRef = useRef({ collapse: collapseSignal, expand: expandSignal })
  useEffect(() => {
    if (collapseSignal === seenSignalsRef.current.collapse) return
    seenSignalsRef.current.collapse = collapseSignal
    const full = buildChangesTreeSnapshot(itemsRef.current, new Set(), 'tree')
    const paths = new Set<string>()
    const walk = (nodes: readonly ChangesTreeNode<TEntry>[]): void => {
      for (const n of nodes) {
        if (n.kind !== 'folder') continue
        paths.add(n.path)
        walk(full.childrenMap.get(n.id) ?? [])
      }
    }
    walk(full.roots)
    setCollapsed(paths)
  }, [collapseSignal])
  useEffect(() => {
    if (expandSignal === seenSignalsRef.current.expand) return
    seenSignalsRef.current.expand = expandSignal
    setCollapsed(new Set())
  }, [expandSignal])

  // Reveal the file the view points at (blame / timeline entry points) and
  // focus the tree on it. A plain data refresh (no revealPath) never steals
  // focus. `snapshot` is a dependency so a reveal issued before the tree has
  // content retries once data lands.
  const revealDoneRef = useRef(false)
  useEffect(() => {
    if (revealDoneRef.current) return
    if (revealPath === undefined) {
      revealDoneRef.current = true
      return
    }
    const node = findChangesTreeFileNode(snapshotRef.current, revealPath)
    if (!node) return
    revealDoneRef.current = true
    void treeModel.reveal(node)
    treeRef.current?.focus({ preventScroll: true })
  }, [snapshot, treeModel, revealPath])

  // When the tree gains DOM focus without a (still-visible) focused row — via
  // the focus command, or after a remount dropped the TreeModel's focus — land
  // on the reveal file, else the remembered file, else the first file row
  // (folders are skipped: they only group).
  const onTreeFocus = useCallback(() => {
    const visible = treeModel.getVisibleNodes()
    const focusedId = treeModel.focused
    if (focusedId != null && visible.some((n) => n.id === focusedId)) return
    const remembered = revealPathRef.current ?? callbacksRef.current.focusMemory?.recall()
    let target =
      remembered !== undefined
        ? findChangesTreeFileNode(snapshotRef.current, remembered)
        : undefined
    if (!target) {
      for (const n of visible) {
        if (n.element.kind === 'file') {
          target = n.element
          break
        }
      }
    }
    if (target) treeModel.setSelection([target.id], target.id)
  }, [treeModel])

  const toggleFolder = useCallback(
    (node: Extract<ChangesTreeNode<TEntry>, { kind: 'folder' }>): void => {
      const willCollapse = !collapsedRef.current.has(node.path)
      // Keep the TreeModel's expansion in lockstep with the view-level collapsed
      // set — the Tree's own keyboard toggle (Enter/Space on a folder with
      // children) only flips the model, and a stale model state would otherwise
      // keep rows hidden after the view set re-expands them.
      treeModel.setExpansion([[node.id, !willCollapse]])
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
    },
    [treeModel],
  )

  const renderRow = (ctx: ITreeRowRenderContext<ChangesTreeNode<TEntry>>) => {
    const n = ctx.node.element
    const shared = {
      model: treeModel,
      indentPadding: ctx.indentPadding,
      isSelected: ctx.isSelected,
      isFocused: ctx.isFocused,
      ...(ctx.style !== undefined ? { rowStyle: ctx.style } : {}),
    }
    if (n.kind === 'folder') {
      return (
        <FolderRow
          key={n.id}
          {...shared}
          node={n}
          expanded={ctx.node.expanded}
          onToggle={toggleFolder}
          testId={folderTestId}
        />
      )
    }
    return (
      <FileRow
        key={n.id}
        {...shared}
        node={n}
        describeFile={stableDescribe}
        onPlain={handlePlainClick}
        onDouble={handleDoubleClick}
      />
    )
  }

  return (
    <div className={styles['content']}>
      {header}
      <Tree<ChangesTreeNode<TEntry>>
        model={treeModel}
        className={styles['tree'] ?? ''}
        virtualListClassName={styles['virtualList'] ?? ''}
        ariaLabel={ariaLabel}
        indentBase={0}
        rootRef={treeRef}
        renderRow={renderRow}
        onFocus={onTreeFocus}
        {...(scrollStateKey !== undefined ? { scrollStateKey } : {})}
        onActivate={(node, opts) => {
          // Source Control parity: Space previews and keeps focus on the tree;
          // Enter opens and hands focus to the editor. A folder with children
          // keeps the Tree's built-in Enter/Space toggle; a view-collapsed
          // folder reports no children, so the Tree delegates it here and we
          // route it back into the same toggle.
          const n = node.element
          if (n.kind === 'folder') {
            toggleFolder(n)
            return
          }
          callbacksRef.current.onActivateFile(n.item.entry, opts)
        }}
      />
    </div>
  )
}
