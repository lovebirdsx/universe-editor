/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PerforceGraphEditor — main-area tab visualizing the Perforce submitted-change
 *  history as a swim-lane graph (SVG) alongside a per-change row table. Perforce
 *  history is a strictly ordered list of numbered changelists (no local merge
 *  DAG), so the graph is a single lane; it reuses the Git Graph layout engine,
 *  file tree, context menu and stylesheet for a consistent experience.
 *
 *  Clicking a row expands that change's details (description + changed files as a
 *  collapsible tree) inline beneath it; clicking a file opens it in a diff editor
 *  via `perforce-graph.openFileDiff`. A synthetic "pending changes" node at the
 *  top mirrors git's uncommitted node. View state is cached in
 *  `perforceGraphViewState` so re-activating the tab is instant.
 *--------------------------------------------------------------------------------------------*/

import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type UIEvent,
} from 'react'
import { type IEditorInput } from '@universe-editor/platform'
import {
  autorun,
  ICommandService,
  IEditorResolverService,
  IFileService,
  INotificationService,
  Severity,
  URI,
  localize,
} from '@universe-editor/platform'
import { FileSymlink } from 'lucide-react'
import {
  PerforceGraphCommands,
  type P4GraphChangeDto,
  type P4GraphChangeDetailsDto,
  type P4GraphFileChangeDto,
  type P4GraphFileDiffRequest,
  type P4GraphLoadOptions,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
} from '@universe-editor/extensions-common'
import { useService, useObservable } from '../useService.js'
import { IScmService } from '../../services/extensions/ScmService.js'
import { computeGraphLayout, type GraphGrid } from '../../services/gitGraph/graphLayout.js'
import { buildFileTree, type FileTreeNode } from '../../services/gitGraph/fileTree.js'
import {
  perforceGraphViewState,
  selectionKey,
  PERFORCE_GRAPH_PAGE_SIZE,
} from '../../services/perforceGraph/perforceGraphViewState.js'
import { scmViewState } from '../scm/scmViewState.js'
import {
  GitGraphContextMenu,
  type GitGraphMenuItem,
  type GitGraphMenuState,
} from '../gitGraph/GitGraphContextMenu.js'
import { SendCommitToAgentChatAction } from '../../actions/agentContextActions.js'
import styles from '../gitGraph/GitGraphEditor.module.css'

const ROW_HEIGHT = 24
const GRID: GraphGrid = { x: 14, y: ROW_HEIGHT, offsetX: 12, offsetY: 12 }
/** Fixed height of the inline detail block; its body scrolls when overflowing. */
const DETAIL_HEIGHT = 300
/** Id of the synthetic pending-changes node prepended above the latest change. */
const PENDING_ID = '*'
/** Idle delay before an external change triggers a background reload. */
const AUTO_REFRESH_DEBOUNCE = 500
/** Minimum width (px) a draggable column can shrink to. */
const MIN_COL_WIDTH = 60

const PALETTE = ['#0085d9']

function shortId(id: string): string {
  return id === PENDING_ID ? '' : `#${id}`
}

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return ''
  return new Date(unixSeconds * 1000).toLocaleString()
}

const STATUS_LABEL: Record<string, string> = {
  A: localize('gitGraph.status.added', 'Added'),
  M: localize('gitGraph.status.modified', 'Modified'),
  D: localize('gitGraph.status.deleted', 'Deleted'),
  R: localize('gitGraph.status.renamed', 'Renamed'),
}

function statusClass(status: string): string | undefined {
  switch (status.charAt(0)) {
    case 'A':
      return styles['statusAdded']
    case 'D':
      return styles['statusDeleted']
    case 'M':
    case 'R':
      return styles['statusModified']
    default:
      return undefined
  }
}

/** A thin draggable divider on a column's left edge; reports the horizontal drag
 *  delta so the caller can resize the column. */
function ColumnResizer({ onResize }: { onResize: (deltaX: number) => void }) {
  const lastX = useRef(0)
  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    lastX.current = e.clientX
    const onMove = (ev: globalThis.MouseEvent) => {
      onResize(ev.clientX - lastX.current)
      lastX.current = ev.clientX
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }
  return <span className={styles['colResizer']} onMouseDown={onMouseDown} />
}

function FileTreeView({
  nodes,
  collapsed,
  onToggle,
  onOpen,
  onOpenFile,
  depth = 0,
}: {
  nodes: readonly FileTreeNode<P4GraphFileChangeDto>[]
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (file: P4GraphFileChangeDto) => void
  onOpenFile?: (file: P4GraphFileChangeDto) => void
  depth?: number
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'dir' ? (
          <Fragment key={`d:${node.path}`}>
            <button
              type="button"
              className={styles['treeRow']}
              style={{ paddingLeft: depth * 12 + 8 }}
              onClick={() => onToggle(node.path)}
            >
              <span className={styles['chevron']}>{collapsed.has(node.path) ? '▶' : '▼'}</span>
              <span className={styles['dirName']}>{node.name}</span>
            </button>
            {!collapsed.has(node.path) && (
              <FileTreeView
                nodes={node.children}
                collapsed={collapsed}
                onToggle={onToggle}
                onOpen={onOpen}
                {...(onOpenFile !== undefined ? { onOpenFile } : {})}
                depth={depth + 1}
              />
            )}
          </Fragment>
        ) : (
          <div
            key={`f:${node.file.path}`}
            className={styles['treeFileRow']}
            style={{ paddingLeft: depth * 12 + 8 + 14 }}
            title={STATUS_LABEL[node.file.status.charAt(0)] ?? node.file.status}
            onClick={() => onOpen(node.file)}
          >
            <span className={`${styles['fileStatus']} ${statusClass(node.file.status) ?? ''}`}>
              {node.file.status.charAt(0)}
            </span>
            <span className={styles['filePath']}>{node.name}</span>
            {onOpenFile && node.file.localPath && (
              <button
                type="button"
                className={styles['fileActionBtn']}
                title={localize('gitGraph.openFile', 'Open File')}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenFile(node.file)
                }}
              >
                <FileSymlink size={14} />
              </button>
            )}
          </div>
        ),
      )}
    </>
  )
}

/** A single change row. Memoised so a selection/scroll/refresh that re-renders
 *  the parent only reconciles the rows whose `selected` actually flipped. */
const ChangeRow = memo(function ChangeRow({
  change,
  selected,
  onRowClick,
  onChangeMenu,
}: {
  change: P4GraphChangeDto
  selected: boolean
  onRowClick: (id: string, e: MouseEvent) => void
  onChangeMenu: (change: P4GraphChangeDto, e: MouseEvent) => void
}) {
  return (
    <div
      className={`${styles['row']} ${selected ? styles['rowSelected'] : ''}`}
      style={{ height: ROW_HEIGHT }}
      data-id={change.id}
      onClick={(e) => onRowClick(change.id, e)}
      onContextMenu={(e) => onChangeMenu(change, e)}
    >
      <span className={styles['graphSpacer']} />
      <span className={styles['description']}>
        <span className={styles['message']}>{change.message}</span>
      </span>
      <span className={styles['author']}>{change.author}</span>
      <span className={styles['date']}>{formatDate(change.date)}</span>
      <span className={styles['hash']}>{shortId(change.id)}</span>
    </div>
  )
})

export function PerforceGraphEditor(_props: { input: IEditorInput }) {
  const commands = useService(ICommandService)
  const scm = useService(IScmService)
  const editorResolverService = useService(IEditorResolverService)
  const fileService = useService(IFileService)
  const notification = useService(INotificationService)
  const [result, setResult] = useState<P4GraphLoadResult | null>(
    () => perforceGraphViewState.result,
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => perforceGraphViewState.result === null)
  const [menu, setMenu] = useState<GitGraphMenuState | null>(null)

  const [selection, setSelection] = useState<string[]>(() => perforceGraphViewState.selection)
  const [details, setDetails] = useState<P4GraphChangeDetailsDto | null>(
    () => perforceGraphViewState.details,
  )
  const [pendingFiles, setPendingFiles] = useState<P4GraphFileChangeDto[] | null>(
    () => perforceGraphViewState.pendingFiles,
  )
  const [panelLoading, setPanelLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        perforceGraphViewState.collapsed[selectionKey(perforceGraphViewState.selection)] ?? [],
      ),
  )

  const [limit, setLimit] = useState(() => perforceGraphViewState.limit)
  const [columnWidths, setColumnWidths] = useState(() => ({
    ...perforceGraphViewState.columnWidths,
  }))
  const [repos, setRepos] = useState<P4GraphRepoDto[]>(() => perforceGraphViewState.repos)
  const [selectedRepo, setSelectedRepo] = useState<string | null>(
    () => perforceGraphViewState.selectedRepo,
  )
  const [searchQuery, setSearchQuery] = useState(() => perforceGraphViewState.searchQuery)
  const deferredQuery = useDeferredValue(searchQuery)

  const queryRef = useRef<P4GraphLoadOptions>({ maxChanges: limit })
  queryRef.current = { maxChanges: limit }

  const scrollRef = useRef<HTMLDivElement>(null)
  const detailBodyRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const fetchedKeyRef = useRef<string | null>(
    perforceGraphViewState.details || perforceGraphViewState.pendingFiles
      ? selectionKey(perforceGraphViewState.selection)
      : null,
  )

  useEffect(() => {
    perforceGraphViewState.focusSearch = () => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    return () => {
      perforceGraphViewState.focusSearch = null
    }
  }, [])

  // Mirror state into the module-level store so it survives unmount.
  useEffect(() => {
    perforceGraphViewState.result = result
  }, [result])
  useEffect(() => {
    perforceGraphViewState.selection = selection
  }, [selection])
  useEffect(() => {
    perforceGraphViewState.details = details
  }, [details])
  useEffect(() => {
    perforceGraphViewState.pendingFiles = pendingFiles
  }, [pendingFiles])
  useEffect(() => {
    perforceGraphViewState.limit = limit
  }, [limit])
  useEffect(() => {
    perforceGraphViewState.columnWidths = columnWidths
  }, [columnWidths])
  useEffect(() => {
    perforceGraphViewState.selectedRepo = selectedRepo
  }, [selectedRepo])
  useEffect(() => {
    perforceGraphViewState.searchQuery = searchQuery
  }, [searchQuery])

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void commands
      .executeCommand<P4GraphLoadResult>(PerforceGraphCommands.getChanges, queryRef.current)
      .then((r) => {
        if (cancelled) return
        setResult(r ?? null)
        setSelection([])
        setDetails(null)
        setPendingFiles(null)
        fetchedKeyRef.current = null
        if (!r)
          setError(
            localize(
              'perforceGraph.unavailable',
              'Perforce Graph is unavailable — is this folder inside a Perforce workspace?',
            ),
          )
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [commands])

  // Background reload: refresh data in place without the loading flicker, keeping
  // the current selection when its change still exists.
  const revalidate = useCallback(
    (forceDetailRefetch = false) => {
      void commands
        .executeCommand<P4GraphLoadResult>(PerforceGraphCommands.getChanges, queryRef.current)
        .then((r) => {
          if (!r) return
          setError(null)
          setResult(r)
          setSelection((prev) => {
            const next = prev.filter(
              (id) => id === PENDING_ID || r.changes.some((c) => c.id === id),
            )
            return next.length === prev.length && next.every((h, i) => h === prev[i]) ? prev : next
          })
          if (forceDetailRefetch) fetchedKeyRef.current = null
        })
        .catch(() => {
          // Transient failure — leave the stale view in place.
        })
    },
    [commands],
  )

  useEffect(() => {
    const start = (): (() => void) | undefined => {
      if (perforceGraphViewState.result) {
        revalidate()
        return undefined
      }
      return load()
    }
    const initialRepo = perforceGraphViewState.selectedRepo
    if (initialRepo) {
      void commands.executeCommand(PerforceGraphCommands.setRepo, initialRepo).then(start)
      return
    }
    return start()
  }, [commands, load, revalidate])

  useEffect(() => {
    void commands.executeCommand<P4GraphRepoDto[]>(PerforceGraphCommands.getRepos).then((r) => {
      if (r) {
        setRepos(r)
        perforceGraphViewState.repos = r
      }
    })
  }, [commands])

  const firstQuery = useRef(true)
  useEffect(() => {
    if (firstQuery.current) {
      firstQuery.current = false
      return
    }
    revalidate()
  }, [limit, revalidate])

  const onSelectRepo = useCallback(
    (root: string) => {
      setSelectedRepo(root)
      void (async () => {
        await commands.executeCommand(PerforceGraphCommands.setRepo, root)
        load()
      })()
    },
    [commands, load],
  )

  // Mirror the SCM-selected repo into the graph.
  const scmSelectedRepo = useObservable(scmViewState.selectedRepo)
  useEffect(() => {
    if (!scmSelectedRepo) return
    if (repos.length === 0) return
    if (!repos.find((r) => r.root === scmSelectedRepo)) return
    const effectiveRepo = selectedRepo ?? repos[0]?.root ?? null
    if (scmSelectedRepo === effectiveRepo) {
      if (selectedRepo === null) setSelectedRepo(scmSelectedRepo)
      return
    }
    onSelectRepo(scmSelectedRepo)
  }, [scmSelectedRepo, repos, selectedRepo, onSelectRepo])

  const adjustColumn = useCallback((col: 'author' | 'date', deltaX: number) => {
    setColumnWidths((prev) => {
      const next = { ...prev, [col]: Math.max(MIN_COL_WIDTH, prev[col] - deltaX) }
      perforceGraphViewState.columnWidths = next
      return next
    })
  }, [])

  // Auto-refresh: any SCM change (open/submit/revert) re-runs `p4 opened`, which
  // the SCM service mirrors as fresh resource arrays. Observe those to debounce a
  // background reload.
  useEffect(() => {
    let first = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const disposable = autorun((r) => {
      for (const sc of scm.sourceControls.read(r)) {
        sc.count.read(r)
        for (const group of sc.groups.read(r)) group.resources.read(r)
      }
      if (first) {
        first = false
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => revalidate(true), AUTO_REFRESH_DEBOUNCE)
    })
    return () => {
      disposable.dispose()
      if (timer) clearTimeout(timer)
    }
  }, [scm, revalidate])

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = perforceGraphViewState.scrollTop
  }, [])

  // Load (or rehydrate) the detail/pending contents when the selection changes.
  const selKey = selectionKey(selection)
  useEffect(() => {
    if (selection.length === 0) {
      setDetails(null)
      setPendingFiles(null)
      fetchedKeyRef.current = null
      return
    }
    if (fetchedKeyRef.current === selKey) return
    let cancelled = false
    setPanelLoading(true)
    if (selection.length === 1 && selection[0] === PENDING_ID) {
      setDetails(null)
      void commands
        .executeCommand<P4GraphFileChangeDto[]>(PerforceGraphCommands.getPendingChanges)
        .then((files) => {
          if (cancelled) return
          setPendingFiles(files ?? [])
          fetchedKeyRef.current = selKey
        })
        .finally(() => {
          if (!cancelled) setPanelLoading(false)
        })
    } else {
      setPendingFiles(null)
      void commands
        .executeCommand<P4GraphChangeDetailsDto | null>(
          PerforceGraphCommands.getChangeDetails,
          selection[0],
        )
        .then((d) => {
          if (cancelled) return
          setDetails(d ?? null)
          fetchedKeyRef.current = selKey
        })
        .finally(() => {
          if (!cancelled) setPanelLoading(false)
        })
    }
    return () => {
      cancelled = true
    }
  }, [commands, selection, selKey])

  useEffect(() => {
    setCollapsed(new Set(perforceGraphViewState.collapsed[selKey] ?? []))
  }, [selKey])

  const onDetailScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      perforceGraphViewState.detailScrollTop[selKey] = e.currentTarget.scrollTop
    },
    [selKey],
  )
  useLayoutEffect(() => {
    if (panelLoading) return
    const el = detailBodyRef.current
    if (el) el.scrollTop = perforceGraphViewState.detailScrollTop[selKey] ?? 0
  }, [selKey, panelLoading, details, pendingFiles])

  const toggleDir = useCallback(
    (path: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        perforceGraphViewState.collapsed[selKey] = [...next]
        return next
      })
    },
    [selKey],
  )

  const onRowClick = useCallback((id: string, _e: MouseEvent) => {
    setSelection((prev) => (prev.length === 1 && prev[0] === id ? [] : [id]))
  }, [])

  const openFileDiff = useCallback(
    (file: P4GraphFileChangeDto) => {
      const req: P4GraphFileDiffRequest = {
        depotFile: file.depotFile,
        status: file.status,
        rev: file.rev,
      }
      void commands.executeCommand(PerforceGraphCommands.openFileDiff, req)
    },
    [commands],
  )

  const openPendingFile = useCallback(
    (file: P4GraphFileChangeDto) => {
      if (file.localPath) {
        void commands.executeCommand(PerforceGraphCommands.openWorkingTreeFile, file.localPath)
      }
    },
    [commands],
  )

  // Open the file's current working-tree copy (not a diff). Perforce resolves
  // `localPath` to an absolute filesystem path via `p4 where`, so — unlike git
  // graph, which joins a repo root with a relative path — we open it directly,
  // going through the resolver so images/markdown route to the right editor.
  const openSourceFile = useCallback(
    (file: P4GraphFileChangeDto) => {
      if (!file.localPath) return
      const resource = URI.file(file.localPath)
      void (async () => {
        try {
          if (!(await fileService.exists(resource))) {
            notification.notify({
              severity: Severity.Warning,
              message: localize(
                'perforceGraph.openFile.notFound',
                'Unable to open {path}: the file does not exist in the current workspace. It may have been deleted, moved, or only exist at this revision.',
                { path: resource.fsPath },
              ),
            })
            return
          }
          await editorResolverService.openEditor(resource, { pinned: true })
        } catch (error) {
          notification.notify({
            severity: Severity.Error,
            message: localize('perforceGraph.openFile.failed', 'Unable to open {path}: {error}', {
              path: resource.fsPath,
              error: error instanceof Error ? error.message : String(error),
            }),
          })
        }
      })()
    },
    [editorResolverService, fileService, notification],
  )

  const openChangeMenu = useCallback(
    (change: P4GraphChangeDto, e: MouseEvent) => {
      e.preventDefault()
      const id = change.id
      if (id === PENDING_ID) return
      const items: GitGraphMenuItem[] = [
        {
          kind: 'item',
          label: localize('perforceGraph.copyId', 'Copy changelist number'),
          run: () => void navigator.clipboard?.writeText(id),
        },
        {
          kind: 'item',
          label: localize('gitGraph.copyMessage', 'Copy commit message'),
          run: () => void navigator.clipboard?.writeText(change.message),
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.sendToAgentChat', 'Send to Agent Chat'),
          run: () =>
            void commands.executeCommand(SendCommitToAgentChatAction.ID, {
              hash: id,
              message: change.message,
            }),
        },
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [commands],
  )

  // Pending changes node, followed by the real changes.
  const displayChanges = useMemo<P4GraphChangeDto[]>(() => {
    if (!result) return []
    if (result.pendingCount > 0) {
      const node: P4GraphChangeDto = {
        id: PENDING_ID,
        parents: result.head ? [result.head] : [],
        author: '',
        client: '',
        date: 0,
        message: localize('perforceGraph.pendingCount', 'Pending Changes ({count})', {
          count: result.pendingCount,
        }),
      }
      return [node, ...result.changes]
    }
    return result.changes
  }, [result])

  const filteredChanges = useMemo<P4GraphChangeDto[]>(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) return displayChanges
    return displayChanges.filter((c) => {
      if (c.id === PENDING_ID) return true
      return (
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.id.toLowerCase().startsWith(q)
      )
    })
  }, [displayChanges, deferredQuery])

  const anchorIndex = useMemo(() => {
    if (selection.length === 0) return -1
    const sel = new Set(selection)
    let idx = -1
    for (let i = 0; i < filteredChanges.length; i++) {
      if (sel.has(filteredChanges[i]!.id)) idx = i
    }
    return idx
  }, [selection, filteredChanges])

  const layout = useMemo(() => {
    if (!result) return null
    const isFiltering = deferredQuery.trim() !== ''
    const filteredIdSet = isFiltering ? new Set(filteredChanges.map((c) => c.id)) : null
    const commits = filteredChanges.map((c) => ({
      hash: c.id,
      parents: filteredIdSet ? c.parents.filter((p) => filteredIdSet.has(p)) : c.parents,
      isUncommitted: c.id === PENDING_ID,
    }))
    return computeGraphLayout(commits, result.head, {
      grid: GRID,
      ...(anchorIndex >= 0 ? { expand: { afterIndex: anchorIndex, height: DETAIL_HEIGHT } } : {}),
    })
  }, [result, filteredChanges, anchorIndex, deferredQuery])

  const graphWidth = layout?.width ?? GRID.offsetX * 2
  const selected = useMemo(() => new Set(selection), [selection])
  const detailTree = useMemo(() => (details ? buildFileTree(details.files) : []), [details])
  const pendingTree = useMemo(
    () => (pendingFiles ? buildFileTree(pendingFiles) : []),
    [pendingFiles],
  )

  const renderDetail = () => {
    if (panelLoading)
      return <div className={styles['detailEmpty']}>{localize('common.loading', 'Loading…')}</div>
    if (selection.length === 1 && selection[0] === PENDING_ID) {
      return (
        <>
          <div className={styles['detailHeader']}>
            <span className={styles['detailTitle']}>
              {localize('perforceGraph.pendingChanges', 'Pending Changes')}
            </span>
            <button
              type="button"
              className={styles['detailClose']}
              onClick={() => setSelection([])}
              title={localize('common.close', 'Close')}
            >
              ×
            </button>
          </div>
          <div className={styles['detailBody']} ref={detailBodyRef} onScroll={onDetailScroll}>
            {pendingFiles && pendingFiles.length === 0 ? (
              <div className={styles['detailEmpty']}>
                {localize('perforceGraph.noPendingChanges', 'No pending changes.')}
              </div>
            ) : (
              <FileTreeView
                nodes={pendingTree}
                collapsed={collapsed}
                onToggle={toggleDir}
                onOpen={openPendingFile}
                onOpenFile={openSourceFile}
              />
            )}
          </div>
        </>
      )
    }
    if (!details)
      return (
        <div className={styles['detailEmpty']}>
          {localize('perforceGraph.noChangeDetails', 'No change details.')}
        </div>
      )
    return (
      <>
        <div className={styles['detailHeader']}>
          <span className={styles['detailTitle']}>
            #{details.id} · {details.author}
            {details.client ? ` @${details.client}` : ''} · {formatDate(details.date)}
          </span>
          <button
            type="button"
            className={styles['detailClose']}
            onClick={() => setSelection([])}
            title={localize('common.close', 'Close')}
          >
            ×
          </button>
        </div>
        <div className={styles['detailBody']} ref={detailBodyRef} onScroll={onDetailScroll}>
          <pre className={styles['commitBody']}>{details.body}</pre>
          {details.files.length === 0 ? (
            <div className={styles['detailEmpty']}>
              {localize('gitGraph.noFileChanges', 'No file changes.')}
            </div>
          ) : (
            <FileTreeView
              nodes={detailTree}
              collapsed={collapsed}
              onToggle={toggleDir}
              onOpen={openFileDiff}
              onOpenFile={openSourceFile}
            />
          )}
        </div>
      </>
    )
  }

  return (
    <div className={styles['gitGraph']} data-testid="perforceGraph-editor">
      <div className={styles['toolbar']}>
        <span className={styles['title']}>{localize('perforceGraph.title', 'Perforce Graph')}</span>
        {result && (
          <span className={styles['count']}>
            {localize('perforceGraph.changeCount', '{count} changes{more}', {
              count: result.changes.length,
              more: result.moreAvailable ? '+' : '',
            })}
            {result.headClient
              ? localize('perforceGraph.onClient', ' · {client}', { client: result.headClient })
              : ''}
          </span>
        )}
        <span className={styles['toolbarSpacer']} />
        <input
          ref={searchInputRef}
          className={styles['searchInput']}
          type="search"
          placeholder={localize('perforceGraph.search.placeholder', 'Search changes…')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label={localize('perforceGraph.search.placeholder', 'Search changes…')}
        />
        {repos.length > 1 && (
          <select
            className={styles['repoSelect']}
            value={selectedRepo ?? repos[0]?.root ?? ''}
            onChange={(e) => onSelectRepo(e.target.value)}
            title={localize('perforceGraph.client', 'Client')}
          >
            {repos.map((r) => (
              <option key={r.root} value={r.root}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className={styles['toolBtn']}
          onClick={() => load()}
          title={localize('common.refresh', 'Refresh')}
          aria-label={localize('common.refresh', 'Refresh')}
        >
          ↺
        </button>
      </div>

      {loading && <div className={styles['status']}>{localize('common.loading', 'Loading…')}</div>}
      {error && <div className={styles['error']}>{error}</div>}

      {result && layout && !loading && (
        <div
          className={styles['scrollBody']}
          ref={scrollRef}
          onScroll={(e) => {
            perforceGraphViewState.scrollTop = e.currentTarget.scrollTop
          }}
        >
          <div className={styles['header']}>
            <span className={styles['graphSpacer']} style={{ width: graphWidth }} />
            <span className={styles['headerDescription']}>
              {localize('gitGraph.header.description', 'Description')}
            </span>
            <span className={styles['headerCol']} style={{ width: columnWidths.author }}>
              <ColumnResizer onResize={(dx) => adjustColumn('author', dx)} />
              {localize('gitGraph.header.author', 'Author')}
            </span>
            <span className={styles['headerCol']} style={{ width: columnWidths.date }}>
              <ColumnResizer onResize={(dx) => adjustColumn('date', dx)} />
              {localize('gitGraph.header.date', 'Date')}
            </span>
            <span className={styles['headerHash']}>
              {localize('perforceGraph.header.change', 'Change')}
            </span>
          </div>
          <div className={styles['canvas']} style={{ height: layout.height }}>
            <svg
              className={styles['graphSvg']}
              width={graphWidth}
              height={layout.height}
              aria-hidden="true"
            >
              {layout.paths.map((p, i) => (
                <path
                  key={i}
                  d={p.d}
                  fill="none"
                  stroke={p.isCommitted ? PALETTE[0] : '#808080'}
                  strokeWidth={2}
                  {...(p.isCommitted ? {} : { strokeDasharray: '2' })}
                />
              ))}
              {layout.vertices.map((v) => {
                if (v.isUncommitted) {
                  return (
                    <circle
                      key={v.id}
                      cx={v.cx}
                      cy={v.cy}
                      r={4}
                      fill="none"
                      stroke="#808080"
                      strokeWidth={2}
                      strokeDasharray="2"
                    />
                  )
                }
                return v.isCurrent ? (
                  <circle
                    key={v.id}
                    cx={v.cx}
                    cy={v.cy}
                    r={4}
                    className={styles['nodeCurrent']}
                    stroke={PALETTE[0]}
                    strokeWidth={2}
                  />
                ) : (
                  <circle key={v.id} cx={v.cx} cy={v.cy} r={4} fill={PALETTE[0]} />
                )
              })}
            </svg>

            <div
              className={styles['rows']}
              style={
                {
                  '--graph-width': `${graphWidth}px`,
                  '--col-author': `${columnWidths.author}px`,
                  '--col-date': `${columnWidths.date}px`,
                } as CSSProperties
              }
            >
              {filteredChanges.map((c, i) => (
                <Fragment key={c.id}>
                  <ChangeRow
                    change={c}
                    selected={selected.has(c.id)}
                    onRowClick={onRowClick}
                    onChangeMenu={openChangeMenu}
                  />
                  {i === anchorIndex && (
                    <div className={styles['detail']} style={{ height: DETAIL_HEIGHT }}>
                      {renderDetail()}
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          </div>
          {result.moreAvailable && (
            <div className={styles['loadMore']}>
              <button
                type="button"
                className={styles['loadMoreBtn']}
                onClick={() => setLimit((l) => l + PERFORCE_GRAPH_PAGE_SIZE)}
              >
                {localize('perforceGraph.loadMore', 'Load more changes')}
              </button>
            </div>
          )}
        </div>
      )}

      {menu && <GitGraphContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
