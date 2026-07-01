/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphEditor — main-area tab visualizing the git commit DAG as a swim-lane
 *  graph (SVG) alongside a per-commit row table. Layout comes from graphLayout.ts;
 *  the SVG overlay and the rows share a fixed row height so nodes line up.
 *
 *  Clicking a row expands that commit's details (parents/message/changed files as
 *  a collapsible tree) inline beneath it; Ctrl/Cmd-clicking a second row compares
 *  the two commits. Clicking a file opens it in a diff editor via the
 *  `git-graph.openFileDiff` command. View state (loaded commits, selection, scroll,
 *  collapse) is cached in `gitGraphViewState` so re-activating the tab is instant.
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
  IDialogService,
  IEditorResolverService,
  IStorageService,
  StorageScope,
  URI,
  localize,
} from '@universe-editor/platform'
import { FileSymlink } from 'lucide-react'
import {
  GitGraphCommands,
  type GitGraphCommitDto,
  type GitGraphCommitDetailsDto,
  type GitGraphFileChangeDto,
  type GitGraphFileDiffRequest,
  type GitGraphLoadOptions,
  type GitGraphLoadResult,
  type GitGraphRepoDto,
  type GitGraphWorktreeDto,
  type GitGraphWorktreeSyncResult,
} from '@universe-editor/extensions-common'
import { useService, useObservable } from '../useService.js'
import { IScmService } from '../../services/extensions/ScmService.js'
import { computeGraphLayout, type GraphGrid } from '../../services/gitGraph/graphLayout.js'
import { buildFileTree, type FileTreeNode } from '../../services/gitGraph/fileTree.js'
import {
  gitGraphViewState,
  selectionKey,
  GIT_GRAPH_PAGE_SIZE,
  type GitGraphSettings,
} from '../../services/gitGraph/gitGraphViewState.js'
import { scmViewState } from '../scm/scmViewState.js'
import {
  GitGraphContextMenu,
  type GitGraphMenuItem,
  type GitGraphMenuState,
} from './GitGraphContextMenu.js'
import {
  GitGraphWorktreePickerDialog,
  type GitGraphWorktreePickerState,
} from './GitGraphWorktreePickerDialog.js'
import styles from './GitGraphEditor.module.css'

const ROW_HEIGHT = 24
const GRID: GraphGrid = { x: 14, y: ROW_HEIGHT, offsetX: 12, offsetY: 12 }
/** Fixed height of the inline detail block; its body scrolls when overflowing. */
const DETAIL_HEIGHT = 300
/** Hash of the synthetic working-tree node prepended above HEAD. */
const UNCOMMITTED_HASH = '*'
/** Idle delay before an external git change triggers a background reload. */
const AUTO_REFRESH_DEBOUNCE = 500
/** Minimum width (px) a draggable column can shrink to. */
const MIN_COL_WIDTH = 60

/** Branch colours, indexed modulo length by the layout's colour index. */
const PALETTE = [
  '#0085d9',
  '#d9008f',
  '#00d90a',
  '#d98500',
  '#a300d9',
  '#ff5454',
  '#00d9cc',
  '#e138e8',
  '#85d900',
  '#dc5b23',
  '#6f24d6',
  '#d9c000',
]

function colourOf(index: number): string {
  return PALETTE[index % PALETTE.length]!
}

function shortHash(hash: string): string {
  return hash.slice(0, 7)
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
  C: localize('gitGraph.status.copied', 'Copied'),
  T: localize('gitGraph.status.typeChanged', 'Type changed'),
  U: localize('gitGraph.status.unmerged', 'Unmerged'),
}

function statusClass(status: string): string | undefined {
  switch (status.charAt(0)) {
    case 'A':
      return styles['statusAdded']
    case 'D':
      return styles['statusDeleted']
    case 'M':
    case 'R':
    case 'C':
    case 'T':
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

/** Max interactive ref badges shown inline before the rest fold into a `+N`
 *  overflow badge. stash is always shown and doesn't count against this. */
const MAX_VISIBLE_REFS = 3

/** One ref attached to a commit, normalized across worktree/head/remote/tag so
 *  the row can sort by priority and fold the overflow behind a single badge.
 *  `priority` is ascending importance — lower shows first, higher folds first. */
interface RefEntry {
  key: string
  className: string
  text: string
  /** Label used in the overflow menu (carries the ref kind, unlike `text`). */
  menuLabel: string
  title?: string
  priority: number
  onMenu: (e: MouseEvent) => void
}

function CommitRefs({
  commit,
  headName,
  onBranchMenu,
  onRemoteMenu,
  onTagMenu,
  onWorktreeMenu,
  onOverflowMenu,
}: {
  commit: GitGraphCommitDto
  headName: string | null
  onBranchMenu: (name: string, e: MouseEvent) => void
  onRemoteMenu: (name: string, e: MouseEvent) => void
  onTagMenu: (name: string, e: MouseEvent) => void
  onWorktreeMenu: (worktree: GitGraphWorktreeDto, e: MouseEvent) => void
  onOverflowMenu: (entries: RefEntry[], e: MouseEvent) => void
}) {
  const entries: RefEntry[] = []
  for (const wt of commit.worktrees) {
    entries.push({
      key: `w-${wt.path}`,
      className: `${styles['badge']} ${styles['badgeWorktree']} ${wt.isCurrent ? styles['badgeWorktreeCurrent'] : ''}`,
      text: wt.isCurrent ? `✓ ${wt.name}` : wt.name,
      menuLabel: localize('gitGraph.ref.worktree', 'Worktree {name}', { name: wt.name }),
      title: wt.branch
        ? localize('gitGraph.worktree.tooltip', 'Worktree {name} · {branch}\n{path}', {
            name: wt.name,
            branch: wt.branch,
            path: wt.path,
          })
        : localize('gitGraph.worktree.tooltipDetached', 'Worktree {name} (detached)\n{path}', {
            name: wt.name,
            path: wt.path,
          }),
      priority: wt.isCurrent ? 1 : 4,
      onMenu: (e) => onWorktreeMenu(wt, e),
    })
  }
  for (const h of commit.heads) {
    entries.push({
      key: `h-${h}`,
      className: `${styles['badge']} ${styles['badgeHead']}`,
      text: h,
      menuLabel: localize('gitGraph.ref.branch', 'Branch {name}', { name: h }),
      priority: h === headName ? 2 : 3,
      onMenu: (e) => onBranchMenu(h, e),
    })
  }
  for (const t of commit.tags) {
    entries.push({
      key: `t-${t.name}`,
      className: `${styles['badge']} ${styles['badgeTag']}`,
      text: t.name,
      menuLabel: localize('gitGraph.ref.tag', 'Tag {name}', { name: t.name }),
      priority: 5,
      onMenu: (e) => onTagMenu(t.name, e),
    })
  }
  for (const r of commit.remotes) {
    entries.push({
      key: `r-${r.name}`,
      className: `${styles['badge']} ${styles['badgeRemote']}`,
      text: r.name,
      menuLabel: localize('gitGraph.ref.remote', 'Remote {name}', { name: r.name }),
      priority: 6,
      onMenu: (e) => onRemoteMenu(r.name, e),
    })
  }
  entries.sort((a, b) => a.priority - b.priority)

  // Show all when only one would fold (a `+1` badge wastes the space it saves);
  // otherwise show MAX_VISIBLE_REFS and fold the rest.
  const visibleCount = entries.length <= MAX_VISIBLE_REFS + 1 ? entries.length : MAX_VISIBLE_REFS
  const visible = entries.slice(0, visibleCount)
  const hidden = entries.slice(visibleCount)

  return (
    <span className={styles['refs']}>
      {commit.stash && <span className={styles['badgeStash']}>{commit.stash.selector}</span>}
      {visible.map((entry) => (
        <span
          key={entry.key}
          className={entry.className}
          title={entry.title}
          onContextMenu={entry.onMenu}
        >
          {entry.text}
        </span>
      ))}
      {hidden.length > 0 && (
        <button
          type="button"
          className={styles['badgeOverflow']}
          title={hidden.map((e) => e.menuLabel).join('\n')}
          onClick={(e) => onOverflowMenu(hidden, e)}
        >
          +{hidden.length}
        </button>
      )}
    </span>
  )
}

function FileTreeView({
  nodes,
  collapsed,
  onToggle,
  onOpen,
  onOpenFile,
  depth = 0,
}: {
  nodes: readonly FileTreeNode[]
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onOpen: (file: GitGraphFileChangeDto) => void
  onOpenFile?: (file: GitGraphFileChangeDto) => void
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
            {onOpenFile && (
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

/** A single commit row. Memoised so a selection/scroll/refresh that re-renders
 *  the parent only reconciles the rows whose `selected` actually flipped — graph
 *  width and column widths are fed via CSS variables on the container (not props)
 *  so they never invalidate this memo. */
const CommitRow = memo(function CommitRow({
  commit,
  selected,
  headName,
  onRowClick,
  onCommitMenu,
  onBranchMenu,
  onRemoteMenu,
  onTagMenu,
  onWorktreeMenu,
  onOverflowMenu,
}: {
  commit: GitGraphCommitDto
  selected: boolean
  headName: string | null
  onRowClick: (hash: string, e: MouseEvent) => void
  onCommitMenu: (commit: GitGraphCommitDto, e: MouseEvent) => void
  onBranchMenu: (name: string, e: MouseEvent) => void
  onRemoteMenu: (name: string, e: MouseEvent) => void
  onTagMenu: (name: string, e: MouseEvent) => void
  onWorktreeMenu: (worktree: GitGraphWorktreeDto, e: MouseEvent) => void
  onOverflowMenu: (entries: RefEntry[], e: MouseEvent) => void
}) {
  return (
    <div
      className={`${styles['row']} ${selected ? styles['rowSelected'] : ''}`}
      style={{ height: ROW_HEIGHT }}
      data-hash={commit.hash}
      onClick={(e) => onRowClick(commit.hash, e)}
      onContextMenu={(e) => onCommitMenu(commit, e)}
    >
      <span className={styles['graphSpacer']} />
      <span className={styles['description']}>
        <CommitRefs
          commit={commit}
          headName={headName}
          onBranchMenu={onBranchMenu}
          onRemoteMenu={onRemoteMenu}
          onTagMenu={onTagMenu}
          onWorktreeMenu={onWorktreeMenu}
          onOverflowMenu={onOverflowMenu}
        />
        <span className={styles['message']}>{commit.message}</span>
      </span>
      <span className={styles['author']}>{commit.author}</span>
      <span className={styles['date']}>{formatDate(commit.date)}</span>
      <span className={styles['hash']}>
        {commit.hash === UNCOMMITTED_HASH ? '' : shortHash(commit.hash)}
      </span>
    </div>
  )
})

export function GitGraphEditor(_props: { input: IEditorInput }) {
  const commands = useService(ICommandService)
  const dialog = useService(IDialogService)
  const editorResolverService = useService(IEditorResolverService)
  const scm = useService(IScmService)
  const storage = useService(IStorageService)
  const [result, setResult] = useState<GitGraphLoadResult | null>(() => gitGraphViewState.result)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => gitGraphViewState.result === null)
  const [menu, setMenu] = useState<GitGraphMenuState | null>(null)
  const [worktreePicker, setWorktreePicker] = useState<GitGraphWorktreePickerState | null>(null)

  // Selected commit(s): one hash to expand details, two to compare.
  const [selection, setSelection] = useState<string[]>(() => gitGraphViewState.selection)
  const [details, setDetails] = useState<GitGraphCommitDetailsDto | null>(
    () => gitGraphViewState.details,
  )
  const [compareFiles, setCompareFiles] = useState<GitGraphFileChangeDto[] | null>(
    () => gitGraphViewState.compareFiles,
  )
  const [panelLoading, setPanelLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(gitGraphViewState.collapsed[selectionKey(gitGraphViewState.selection)] ?? []),
  )

  // View options, paging limit, column widths and repo selection. Each mirrors a
  // field in the module-level store so it survives the tab being unmounted.
  const [settings, setSettings] = useState<GitGraphSettings>(() => ({
    ...gitGraphViewState.settings,
  }))
  const [limit, setLimit] = useState(() => gitGraphViewState.limit)
  const [columnWidths, setColumnWidths] = useState(() => ({ ...gitGraphViewState.columnWidths }))
  const [repos, setRepos] = useState<GitGraphRepoDto[]>(() => gitGraphViewState.repos)
  const [selectedRepo, setSelectedRepo] = useState<string | null>(
    () => gitGraphViewState.selectedRepo,
  )
  const [showSettings, setShowSettings] = useState(false)
  const [searchQuery, setSearchQuery] = useState(() => gitGraphViewState.searchQuery)
  // Filtering / layout / full-list re-render read the deferred value so typing in
  // the search box stays responsive — the heavy recompute runs at low priority.
  const deferredQuery = useDeferredValue(searchQuery)

  // The current getCommits options, kept in a ref so load/revalidate stay stable
  // callbacks while always reading the latest settings/limit.
  const queryRef = useRef<GitGraphLoadOptions>({
    maxCommits: limit,
    order: settings.order,
    includeRemotes: settings.includeRemotes,
  })
  queryRef.current = {
    maxCommits: limit,
    order: settings.order,
    includeRemotes: settings.includeRemotes,
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const detailBodyRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Selection key whose details/compareFiles are already loaded — skips refetch on remount.
  const fetchedKeyRef = useRef<string | null>(
    gitGraphViewState.details || gitGraphViewState.compareFiles
      ? selectionKey(gitGraphViewState.selection)
      : null,
  )

  useEffect(() => {
    gitGraphViewState.focusSearch = () => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    return () => {
      gitGraphViewState.focusSearch = null
    }
  }, [])

  useEffect(() => {
    gitGraphViewState.toggleRemoteBranches = () =>
      setSettings((s) => ({ ...s, includeRemotes: !s.includeRemotes }))
    return () => {
      gitGraphViewState.toggleRemoteBranches = null
    }
  }, [])

  const settingsLoadedRef = useRef(false)
  useEffect(() => {
    void storage
      .get<Partial<GitGraphSettings>>('gitGraph.settings', StorageScope.GLOBAL)
      .then((stored) => {
        if (stored) setSettings((s) => ({ ...s, ...stored }))
        settingsLoadedRef.current = true
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!settingsLoadedRef.current) return
    void storage.set('gitGraph.settings', settings, StorageScope.GLOBAL)
  }, [settings, storage])

  // Mirror state into the module-level store so it survives unmount.
  useEffect(() => {
    gitGraphViewState.result = result
  }, [result])
  useEffect(() => {
    gitGraphViewState.selection = selection
  }, [selection])
  useEffect(() => {
    gitGraphViewState.details = details
  }, [details])
  useEffect(() => {
    gitGraphViewState.compareFiles = compareFiles
  }, [compareFiles])
  useEffect(() => {
    gitGraphViewState.settings = settings
  }, [settings])
  useEffect(() => {
    gitGraphViewState.limit = limit
  }, [limit])
  useEffect(() => {
    gitGraphViewState.columnWidths = columnWidths
  }, [columnWidths])
  useEffect(() => {
    gitGraphViewState.selectedRepo = selectedRepo
  }, [selectedRepo])
  useEffect(() => {
    gitGraphViewState.searchQuery = searchQuery
  }, [searchQuery])

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void commands
      .executeCommand<GitGraphLoadResult>(GitGraphCommands.getCommits, queryRef.current)
      .then((r) => {
        if (cancelled) return
        setResult(r ?? null)
        // A fresh load invalidates the previous selection and its cached detail.
        setSelection([])
        setDetails(null)
        setCompareFiles(null)
        fetchedKeyRef.current = null
        if (!r)
          setError(
            localize(
              'gitGraph.unavailable',
              'Git Graph is unavailable — is this folder a git repository?',
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
  // the current selection when its commit still exists. Used by auto-refresh and
  // when re-activating a cached tab (stale-while-revalidate).
  //
  // `forceDetailRefetch` re-pulls the open detail panel. Only real git changes
  // (auto-refresh) need it — the working-tree file list may have changed. When
  // re-activating a cached tab nothing changed, so refetching would just flash
  // the open commit's detail ("Loading…" → same data); committed diffs are
  // immutable anyway.
  const revalidate = useCallback(
    (forceDetailRefetch = false) => {
      void commands
        .executeCommand<GitGraphLoadResult>(GitGraphCommands.getCommits, queryRef.current)
        .then((r) => {
          if (!r) return
          setError(null)
          setResult(r)
          setSelection((prev) => {
            const next = prev.filter(
              (h) => h === UNCOMMITTED_HASH || r.commits.some((c) => c.hash === h),
            )
            // Keep the previous array reference when unchanged so the detail
            // effect's `selection` dependency doesn't re-run needlessly.
            return next.length === prev.length && next.every((h, i) => h === prev[i]) ? prev : next
          })
          if (forceDetailRefetch) fetchedKeyRef.current = null
        })
        .catch(() => {
          // A transient failure (e.g. host restarting) leaves the stale view in place.
        })
    },
    [commands],
  )

  // Initial load only when nothing is cached; a cached tab revalidates in the
  // background so re-activating it shows fresh data without a flash. If a
  // non-default repo was selected previously, re-assert it on the extension side
  // first (its active-repo state may have reset across an app restart).
  useEffect(() => {
    const start = (): (() => void) | undefined => {
      if (gitGraphViewState.result) {
        revalidate()
        return undefined
      }
      return load()
    }
    const initialRepo = gitGraphViewState.selectedRepo
    if (initialRepo) {
      void commands.executeCommand(GitGraphCommands.setRepo, initialRepo).then(start)
      return
    }
    return start()
  }, [commands, load, revalidate])

  // Discover the repositories the view can switch between (main repo + submodules).
  useEffect(() => {
    void commands.executeCommand<GitGraphRepoDto[]>(GitGraphCommands.getRepos).then((r) => {
      if (r) {
        setRepos(r)
        gitGraphViewState.repos = r
      }
    })
  }, [commands])

  // Refetch when a query-affecting option changes (order / remotes / paging
  // limit). First-parent only affects layout, so it is deliberately excluded.
  const firstQuery = useRef(true)
  useEffect(() => {
    if (firstQuery.current) {
      firstQuery.current = false
      return
    }
    revalidate()
  }, [settings.order, settings.includeRemotes, limit, revalidate])

  const onSelectRepo = useCallback(
    (root: string) => {
      setSelectedRepo(root)
      void (async () => {
        await commands.executeCommand(GitGraphCommands.setRepo, root)
        load()
      })()
    },
    [commands, load],
  )

  // Mirror the SCM-selected repo into the graph. Compare against the live
  // `selectedRepo` (seeded from the surviving module store) rather than a ref —
  // a ref resets to undefined on every remount, so it would mistake re-activating
  // the tab for a repo switch and force a full reload, wiping selection/scroll.
  const scmSelectedRepo = useObservable(scmViewState.selectedRepo)
  useEffect(() => {
    if (!scmSelectedRepo) return
    if (repos.length === 0) return
    if (!repos.find((r) => r.root === scmSelectedRepo)) return
    // On first open `selectedRepo` is still null, but the initial load already
    // targeted the extension's default repo — the first discovered repo (the
    // main repo). When the SCM-selected repo matches that default, only adopt it
    // as our selection: issuing a reload would re-fetch identical data and flash
    // a second "loading" (the first-open double-load).
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
      gitGraphViewState.columnWidths = next
      return next
    })
  }, [])

  // Auto-refresh: any git change (commit, checkout, stage, working-tree edit)
  // re-runs the repo's `git status`, which the SCM service mirrors as fresh
  // resource arrays. Observe those to debounce a background reload.
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

  // Restore scroll position after the body is laid out.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = gitGraphViewState.scrollTop
  }, [])

  // Load (or rehydrate) the detail/compare contents when the selection changes.
  const selKey = selectionKey(selection)
  useEffect(() => {
    if (selection.length === 0) {
      setDetails(null)
      setCompareFiles(null)
      fetchedKeyRef.current = null
      return
    }
    if (fetchedKeyRef.current === selKey) return // already have data for this selection
    let cancelled = false
    setPanelLoading(true)
    if (selection.length === 1 && selection[0] === UNCOMMITTED_HASH) {
      setDetails(null)
      void commands
        .executeCommand<GitGraphFileChangeDto[]>(GitGraphCommands.getUncommittedChanges)
        .then((files) => {
          if (cancelled) return
          setCompareFiles(files ?? [])
          fetchedKeyRef.current = selKey
        })
        .finally(() => {
          if (!cancelled) setPanelLoading(false)
        })
    } else if (selection.length === 1) {
      setCompareFiles(null)
      void commands
        .executeCommand<GitGraphCommitDetailsDto | null>(
          GitGraphCommands.getCommitDetails,
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
    } else {
      setDetails(null)
      void commands
        .executeCommand<GitGraphFileChangeDto[]>(
          GitGraphCommands.compareCommits,
          selection[0],
          selection[1],
        )
        .then((files) => {
          if (cancelled) return
          setCompareFiles(files ?? [])
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

  // Restore per-selection collapse state.
  useEffect(() => {
    setCollapsed(new Set(gitGraphViewState.collapsed[selKey] ?? []))
  }, [selKey])

  // Persist and restore the detail panel's scroll offset per selection so it
  // survives tab switches. Restore after the (async) content has rendered.
  const onDetailScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      gitGraphViewState.detailScrollTop[selKey] = e.currentTarget.scrollTop
    },
    [selKey],
  )
  useLayoutEffect(() => {
    if (panelLoading) return
    const el = detailBodyRef.current
    if (el) el.scrollTop = gitGraphViewState.detailScrollTop[selKey] ?? 0
  }, [selKey, panelLoading, details, compareFiles])

  const toggleDir = useCallback(
    (path: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        gitGraphViewState.collapsed[selKey] = [...next]
        return next
      })
    },
    [selKey],
  )

  const onRowClick = useCallback((hash: string, e: MouseEvent) => {
    const multi = e.ctrlKey || e.metaKey
    setSelection((prev) => {
      if (multi && prev.length >= 1 && prev[0] !== hash) return [prev[0]!, hash]
      if (!multi && prev.length === 1 && prev[0] === hash) return []
      return [hash]
    })
  }, [])

  const openFile = useCallback(
    (file: GitGraphFileChangeDto, fromHash: string, toHash: string) => {
      const req: GitGraphFileDiffRequest = {
        fromHash,
        toHash,
        path: file.path,
        status: file.status,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      }
      void commands.executeCommand(GitGraphCommands.openFileDiff, req)
    },
    [commands],
  )

  const openWorkingTreeFile = useCallback(
    (file: GitGraphFileChangeDto) => {
      void commands.executeCommand(GitGraphCommands.openWorkingTreeFile, file.path)
    },
    [commands],
  )

  const openSourceFile = useCallback(
    (file: GitGraphFileChangeDto) => {
      if (!selectedRepo) return
      void editorResolverService.openEditor(URI.joinPath(URI.file(selectedRepo), file.path), {
        pinned: true,
      })
    },
    [editorResolverService, selectedRepo],
  )

  // Run a mutating op, then revalidate in place so the scroll position and
  // surviving selection are kept (a full reload would reset both).
  const runOp = useCallback(
    (id: string, ...args: unknown[]): void => {
      void (async () => {
        await commands.executeCommand(id, ...args)
        revalidate()
      })()
    },
    [commands, revalidate],
  )

  const openCommitMenu = useCallback(
    (commit: GitGraphCommitDto, e: MouseEvent) => {
      e.preventDefault()
      const hash = commit.hash
      if (hash === UNCOMMITTED_HASH) return // working-tree node has no actions yet
      if (commit.stash) {
        const selector = commit.stash.selector
        setMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            {
              kind: 'item',
              label: localize('gitGraph.stash.apply', 'Apply stash…'),
              run: () => runOp(GitGraphCommands.stashApply, selector),
            },
            {
              kind: 'item',
              label: localize('gitGraph.stash.pop', 'Pop stash…'),
              run: () => runOp(GitGraphCommands.stashPop, selector),
            },
            { kind: 'sep' },
            {
              kind: 'item',
              label: localize('gitGraph.stash.drop', 'Drop stash…'),
              danger: true,
              run: async () => {
                const r = await dialog.confirm({
                  message: localize('gitGraph.stash.dropConfirm', 'Drop {selector}?', {
                    selector,
                  }),
                  detail: localize(
                    'gitGraph.stash.dropDetail',
                    'The stashed changes will be lost.',
                  ),
                  primaryButton: localize('gitGraph.stash.dropButton', 'Drop'),
                  type: 'warning',
                })
                if (r.confirmed) runOp(GitGraphCommands.stashDrop, selector)
              },
            },
            { kind: 'sep' },
            {
              kind: 'item',
              label: localize('gitGraph.copyHash', 'Copy commit hash'),
              run: () => void navigator.clipboard?.writeText(hash),
            },
          ],
        })
        return
      }
      const items: GitGraphMenuItem[] = [
        {
          kind: 'item',
          label: localize('gitGraph.checkoutCommit', 'Checkout this commit…'),
          run: async () => {
            const r = await dialog.confirm({
              message: localize('gitGraph.checkoutCommit.confirm', 'Checkout commit {hash}?', {
                hash: shortHash(hash),
              }),
              detail: localize('gitGraph.checkoutCommit.detail', 'This leaves HEAD detached.'),
              primaryButton: localize('gitGraph.checkout', 'Checkout'),
            })
            if (r.confirmed) runOp(GitGraphCommands.checkout, hash)
          },
        },
        {
          kind: 'item',
          label: localize('gitGraph.cherryPick', 'Cherry-pick…'),
          run: () => runOp(GitGraphCommands.cherrypick, hash),
        },
        {
          kind: 'item',
          label: localize('gitGraph.revert', 'Revert…'),
          run: () => runOp(GitGraphCommands.revert, hash),
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.mergeCurrent', 'Merge into current branch…'),
          run: () => runOp(GitGraphCommands.merge, hash),
        },
        {
          kind: 'item',
          label: localize('gitGraph.rebaseCurrentCommit', 'Rebase current branch on this commit…'),
          run: () => runOp(GitGraphCommands.rebase, hash),
        },
        {
          kind: 'item',
          label: localize('gitGraph.resetCurrentCommit', 'Reset current branch to this commit…'),
          danger: true,
          run: async () => {
            const r = await dialog.confirm({
              message: localize(
                'gitGraph.resetCurrentCommit.confirm',
                'Reset current branch to {hash}?',
                { hash: shortHash(hash) },
              ),
              detail: localize(
                'gitGraph.resetCurrentCommit.detail',
                'Mixed keeps your changes unstaged. Hard discards all working-tree changes.',
              ),
              primaryButton: localize('gitGraph.reset.mixed', 'Mixed'),
              secondaryButton: localize('gitGraph.reset.hard', 'Hard'),
              type: 'warning',
            })
            if (r.choice === 'primary') runOp(GitGraphCommands.reset, hash, 'mixed')
            else if (r.choice === 'secondary') runOp(GitGraphCommands.reset, hash, 'hard')
          },
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.createBranchHere', 'Create branch here…'),
          run: async () => {
            const name = await dialog.prompt({
              title: localize('gitGraph.newBranchName', 'New branch name'),
            })
            if (name?.trim()) runOp(GitGraphCommands.createBranch, hash, name.trim(), true)
          },
        },
        {
          kind: 'item',
          label: localize('gitGraph.createTagHere', 'Create tag here…'),
          run: async () => {
            const name = await dialog.prompt({
              title: localize('gitGraph.newTagName', 'New tag name'),
            })
            if (name?.trim()) runOp(GitGraphCommands.createTag, hash, name.trim(), undefined)
          },
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.copyHash', 'Copy commit hash'),
          run: () => void navigator.clipboard?.writeText(hash),
        },
        {
          kind: 'item',
          label: localize('gitGraph.copyMessage', 'Copy commit message'),
          run: () => void navigator.clipboard?.writeText(commit.message),
        },
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [dialog, runOp],
  )

  const openBranchMenu = useCallback(
    (name: string, e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const items: GitGraphMenuItem[] = [
        {
          kind: 'item',
          label: localize('gitGraph.checkout', 'Checkout'),
          run: () => runOp(GitGraphCommands.checkout, name),
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.mergeCurrent', 'Merge into current branch…'),
          run: () => runOp(GitGraphCommands.merge, name),
        },
        {
          kind: 'item',
          label: localize('gitGraph.rebaseCurrentBranch', 'Rebase current branch on branch…'),
          run: () => runOp(GitGraphCommands.rebase, name),
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.rename', 'Rename…'),
          run: async () => {
            const newName = await dialog.prompt({
              title: localize('gitGraph.renameBranch', 'Rename branch'),
              initialValue: name,
            })
            if (newName?.trim() && newName.trim() !== name) {
              runOp(GitGraphCommands.renameBranch, name, newName.trim())
            }
          },
        },
        {
          kind: 'item',
          label: localize('gitGraph.push', 'Push…'),
          run: () => runOp(GitGraphCommands.pushBranch, name, 'origin'),
        },
        {
          kind: 'item',
          label: localize('gitGraph.pushForce', 'Push (Force)…'),
          danger: true,
          run: async () => {
            const r = await dialog.confirm({
              message: localize('gitGraph.forcePush.confirm', "Force push '{name}' to origin?", {
                name,
              }),
              detail: localize(
                'gitGraph.forcePush.detail',
                'This overwrites the remote branch history and can discard others’ commits.',
              ),
              primaryButton: localize('gitGraph.forcePush.button', 'Force Push'),
              type: 'warning',
            })
            if (r.confirmed) runOp(GitGraphCommands.pushBranch, name, 'origin', true)
          },
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('common.deleteWithEllipsis', 'Delete…'),
          danger: true,
          run: async () => {
            const r = await dialog.confirm({
              message: localize('gitGraph.deleteBranch.confirm', "Delete branch '{name}'?", {
                name,
              }),
              detail: localize(
                'gitGraph.deleteBranch.detail',
                'Force Delete removes it even if it is not fully merged.',
              ),
              primaryButton: localize('common.delete', 'Delete'),
              secondaryButton: localize('gitGraph.forceDelete', 'Force Delete'),
              type: 'warning',
            })
            if (r.choice === 'primary') runOp(GitGraphCommands.deleteBranch, name, false)
            else if (r.choice === 'secondary') runOp(GitGraphCommands.deleteBranch, name, true)
          },
        },
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [dialog, runOp],
  )

  const openRemoteMenu = useCallback(
    (name: string, e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const items: GitGraphMenuItem[] = [
        {
          kind: 'item',
          label: localize('gitGraph.checkoutLocalBranch', 'Checkout as local branch…'),
          run: async () => {
            const suggested = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
            const local = await dialog.prompt({
              title: localize('gitGraph.localBranchName', 'Local branch name'),
              initialValue: suggested,
            })
            if (local?.trim()) runOp(GitGraphCommands.checkoutRemote, name, local.trim())
          },
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.deleteRemoteBranch', 'Delete remote branch…'),
          danger: true,
          run: async () => {
            const r = await dialog.confirm({
              message: localize(
                'gitGraph.deleteRemoteBranch.confirm',
                "Delete remote branch '{name}'?",
                { name },
              ),
              detail: localize(
                'gitGraph.deleteRemoteBranch.detail',
                'This will delete the branch from the remote server.',
              ),
              primaryButton: localize('common.delete', 'Delete'),
              type: 'warning',
            })
            if (r.confirmed) runOp(GitGraphCommands.deleteRemoteBranch, name)
          },
        },
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [dialog, runOp],
  )

  const openTagMenu = useCallback(
    (name: string, e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const items: GitGraphMenuItem[] = [
        {
          kind: 'item',
          label: localize('gitGraph.pushTag', 'Push tag…'),
          run: () => runOp(GitGraphCommands.pushTag, name, 'origin'),
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.deleteTag', 'Delete tag…'),
          danger: true,
          run: async () => {
            const r = await dialog.confirm({
              message: localize('gitGraph.deleteTag.confirm', "Delete tag '{name}'?", { name }),
              primaryButton: localize('common.delete', 'Delete'),
              type: 'warning',
            })
            if (r.confirmed) runOp(GitGraphCommands.deleteTag, name)
          },
        },
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [dialog, runOp],
  )

  // Every worktree across the loaded commits — each commit carries only its own,
  // so flatten them for the sync picker's candidate list.
  const allWorktrees = useMemo<GitGraphWorktreeDto[]>(() => {
    if (!result) return []
    return result.commits.flatMap((c) => c.worktrees)
  }, [result])

  // Reset the picked worktrees' branches to the target, then report a summary and
  // reload the graph. dirty worktrees are skipped by the extension side.
  const runWorktreeSync = useCallback(
    async (targetBranch: string, selectedPaths: string[]) => {
      setWorktreePicker(null)
      const selected = allWorktrees.filter((wt) => selectedPaths.includes(wt.path))
      const refs = selected.map((wt) => ({ path: wt.path, name: wt.name }))
      const summary = await commands.executeCommand<GitGraphWorktreeSyncResult>(
        GitGraphCommands.syncWorktrees,
        targetBranch,
        refs,
      )
      revalidate()
      if (!summary) return
      const lines: string[] = []
      if (summary.synced.length > 0) {
        lines.push(
          localize('gitGraph.worktree.sync.summarySynced', 'Synced: {names}', {
            names: summary.synced.join(', '),
          }),
        )
      }
      if (summary.skippedDirty.length > 0) {
        lines.push(
          localize(
            'gitGraph.worktree.sync.summarySkipped',
            'Skipped (uncommitted changes): {names}',
            { names: summary.skippedDirty.join(', ') },
          ),
        )
      }
      if (summary.skippedUnmerged.length > 0) {
        lines.push(
          localize(
            'gitGraph.worktree.sync.summaryUnmerged',
            'Skipped (commits not in {branch}): {names}',
            { branch: targetBranch, names: summary.skippedUnmerged.join(', ') },
          ),
        )
      }
      if (summary.failed.length > 0) {
        lines.push(
          localize('gitGraph.worktree.sync.summaryFailed', 'Failed: {items}', {
            items: summary.failed.map((f) => `${f.name} (${f.error})`).join('; '),
          }),
        )
      }
      await dialog.confirm({
        message: localize('gitGraph.worktree.sync.summaryTitle', 'Worktree sync to {branch}', {
          branch: targetBranch,
        }),
        detail:
          lines.join('\n') || localize('gitGraph.worktree.sync.summaryNone', 'Nothing to do.'),
        primaryButton: localize('common.ok', 'OK'),
      })
    },
    [allWorktrees, commands, dialog, revalidate],
  )

  const openWorktreeMenu = useCallback(
    (worktree: GitGraphWorktreeDto, e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const { path, name, branch, isCurrent, isMain } = worktree
      const items: GitGraphMenuItem[] = []
      // The current worktree is already open in this window — only offer "new window".
      if (!isCurrent) {
        items.push({
          kind: 'item',
          label: localize('gitGraph.worktree.open', 'Open worktree'),
          run: () => void commands.executeCommand(GitGraphCommands.openWorktree, path, false),
        })
      }
      items.push({
        kind: 'item',
        label: localize('gitGraph.worktree.openNewWindow', 'Open worktree in new window'),
        run: () => void commands.executeCommand(GitGraphCommands.openWorktree, path, true),
      })
      items.push(
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.worktree.copyPath', 'Copy worktree path'),
          run: () => void navigator.clipboard?.writeText(path),
        },
      )
      // Sync other worktrees onto this one's branch (git reset --hard <branch>).
      // Only meaningful when this worktree has a branch and others exist to sync.
      const others = allWorktrees
        .filter((wt) => wt.path !== path)
        .sort((a, b) => a.name.localeCompare(b.name))
      if (branch && others.length > 0) {
        items.push(
          { kind: 'sep' },
          {
            kind: 'item',
            label: localize('gitGraph.worktree.syncToThis', 'Sync worktrees to {branch}…', {
              branch,
            }),
            run: () => setWorktreePicker({ targetBranch: branch, candidates: others }),
          },
        )
      }
      // The main and the currently-open worktree can't be removed from here.
      if (!isCurrent && !isMain) {
        items.push(
          { kind: 'sep' },
          {
            kind: 'item',
            label: localize('gitGraph.worktree.delete', 'Delete worktree…'),
            danger: true,
            run: async () => {
              const r = await dialog.confirm({
                message: localize('gitGraph.worktree.deleteConfirm', "Delete worktree '{name}'?", {
                  name,
                }),
                detail: localize(
                  'gitGraph.worktree.deleteDetail',
                  'This removes the worktree folder at {path}. The branch itself is kept.',
                  { path },
                ),
                primaryButton: localize('common.delete', 'Delete'),
                type: 'warning',
              })
              if (r.confirmed) runOp(GitGraphCommands.deleteWorktree, path)
            },
          },
        )
      }
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [allWorktrees, commands, dialog, runOp],
  )

  // Folded refs (the `+N` badge): list each hidden ref; clicking one re-dispatches
  // at the same screen point to its own kind's menu, so every action stays reachable.
  const openOverflowMenu = useCallback((entries: RefEntry[], e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const anchor = {
      clientX: e.clientX,
      clientY: e.clientY,
      preventDefault: () => {},
      stopPropagation: () => {},
    } as MouseEvent
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: entries.map((entry) => ({
        kind: 'item' as const,
        label: entry.menuLabel,
        run: () => entry.onMenu(anchor),
      })),
    })
  }, [])

  // uncommitted changes, followed by the real (and stash) commits.
  const displayCommits = useMemo<GitGraphCommitDto[]>(() => {
    if (!result) return []
    if (result.uncommittedChanges > 0 && result.head) {
      const node: GitGraphCommitDto = {
        hash: UNCOMMITTED_HASH,
        parents: [result.head],
        author: '',
        email: '',
        date: 0,
        message: localize('gitGraph.uncommittedCount', 'Uncommitted Changes ({count})', {
          count: result.uncommittedChanges,
        }),
        heads: [],
        tags: [],
        remotes: [],
        stash: null,
        worktrees: [],
      }
      return [node, ...result.commits]
    }
    return result.commits
  }, [result])

  // Free-text filter over the loaded commits. Filtering only the loaded set
  // (not refetching) matches the "search what's loaded" behaviour; the layout
  // tolerates parents missing from the subset (drawn as dangling lines).
  const filteredCommits = useMemo<GitGraphCommitDto[]>(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) return displayCommits
    return displayCommits.filter((c) => {
      if (c.hash === UNCOMMITTED_HASH) return true
      return (
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.hash.toLowerCase().startsWith(q)
      )
    })
  }, [displayCommits, deferredQuery])

  // Index of the row beneath which the inline detail block is rendered. For a
  // comparison it anchors under the lower (later) of the two selected commits.
  const anchorIndex = useMemo(() => {
    if (selection.length === 0) return -1
    const sel = new Set(selection)
    let idx = -1
    for (let i = 0; i < filteredCommits.length; i++) {
      if (sel.has(filteredCommits[i]!.hash)) idx = i
    }
    return idx
  }, [selection, filteredCommits])

  const layout = useMemo(() => {
    if (!result) return null
    const commits = filteredCommits.map((c) => ({
      hash: c.hash,
      parents: c.parents,
      isStash: c.stash !== null,
      isUncommitted: c.hash === UNCOMMITTED_HASH,
    }))
    return computeGraphLayout(commits, result.head, {
      grid: GRID,
      onlyFollowFirstParent: settings.onlyFollowFirstParent,
      ...(anchorIndex >= 0 ? { expand: { afterIndex: anchorIndex, height: DETAIL_HEIGHT } } : {}),
    })
  }, [result, filteredCommits, anchorIndex, settings.onlyFollowFirstParent])

  const graphWidth = layout?.width ?? GRID.offsetX * 2
  const selected = useMemo(() => new Set(selection), [selection])
  const detailTree = useMemo(() => (details ? buildFileTree(details.files) : []), [details])
  const compareTree = useMemo(
    () => (compareFiles ? buildFileTree(compareFiles) : []),
    [compareFiles],
  )

  const renderDetail = () => {
    if (panelLoading)
      return <div className={styles['detailEmpty']}>{localize('common.loading', 'Loading…')}</div>
    if (selection.length === 1 && selection[0] === UNCOMMITTED_HASH) {
      return (
        <>
          <div className={styles['detailHeader']}>
            <span className={styles['detailTitle']}>
              {localize('gitGraph.uncommittedChanges', 'Uncommitted Changes')}
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
            {compareFiles && compareFiles.length === 0 ? (
              <div className={styles['detailEmpty']}>
                {localize('gitGraph.noUncommittedChanges', 'No uncommitted changes.')}
              </div>
            ) : (
              <FileTreeView
                nodes={compareTree}
                collapsed={collapsed}
                onToggle={toggleDir}
                onOpen={openWorkingTreeFile}
                onOpenFile={openSourceFile}
              />
            )}
          </div>
        </>
      )
    }
    if (selection.length === 2) {
      return (
        <>
          <div className={styles['detailHeader']}>
            <span className={styles['detailTitle']}>
              {localize('gitGraph.comparing', 'Comparing {left} ↔ {right}', {
                left: shortHash(selection[0]!),
                right: shortHash(selection[1]!),
              })}
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
            {compareFiles && compareFiles.length === 0 ? (
              <div className={styles['detailEmpty']}>
                {localize('gitGraph.noFileChanges', 'No file changes.')}
              </div>
            ) : (
              <FileTreeView
                nodes={compareTree}
                collapsed={collapsed}
                onToggle={toggleDir}
                onOpen={(f) => openFile(f, selection[0]!, selection[1]!)}
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
          {localize('gitGraph.noCommitDetails', 'No commit details.')}
        </div>
      )
    return (
      <>
        <div className={styles['detailHeader']}>
          <span className={styles['detailTitle']}>
            {shortHash(details.hash)} · {details.author}
            {details.authorEmail ? ` <${details.authorEmail}>` : ''} ·{' '}
            {formatDate(details.authorDate)}
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
          {details.parents.length > 0 && (
            <div className={styles['detailMeta']}>
              {localize('gitGraph.parents', 'Parents:')} {details.parents.map(shortHash).join(', ')}
            </div>
          )}
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
              onOpen={(f) => openFile(f, details.parents[0] ?? '', details.hash)}
              onOpenFile={openSourceFile}
            />
          )}
        </div>
      </>
    )
  }

  return (
    <div className={styles['gitGraph']} data-testid="gitGraph-editor">
      <div className={styles['toolbar']}>
        <span className={styles['title']}>{localize('gitGraph.title', 'Git Graph')}</span>
        {result && (
          <span className={styles['count']}>
            {localize('gitGraph.commitCount', '{count} commits{more}', {
              count: result.commits.length,
              more: result.moreAvailable ? '+' : '',
            })}
            {result.headName
              ? localize('gitGraph.onBranch', ' · on {branch}', { branch: result.headName })
              : ''}
          </span>
        )}
        <span className={styles['toolbarSpacer']} />
        <input
          ref={searchInputRef}
          className={styles['searchInput']}
          type="search"
          placeholder={localize('gitGraph.search.placeholder', 'Search commits…')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label={localize('gitGraph.search.placeholder', 'Search commits…')}
        />
        {repos.length > 1 && (
          <select
            className={styles['repoSelect']}
            value={selectedRepo ?? repos[0]?.root ?? ''}
            onChange={(e) => onSelectRepo(e.target.value)}
            title={localize('gitGraph.repository', 'Repository')}
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
          className={`${styles['toolBtn']} ${settings.includeRemotes ? styles['toolBtnActive'] : ''}`}
          onClick={() => setSettings((s) => ({ ...s, includeRemotes: !s.includeRemotes }))}
          title={
            settings.includeRemotes
              ? localize('gitGraph.hideRemoteBranches', 'Hide remote branches')
              : localize('gitGraph.showRemoteBranches', 'Show remote branches')
          }
          aria-pressed={settings.includeRemotes}
        >
          ⎇
        </button>
        <button
          type="button"
          className={styles['toolBtn']}
          onClick={() => setShowSettings((s) => !s)}
          title={localize('gitGraph.viewSettings', 'View settings')}
          aria-label={localize('gitGraph.viewSettings', 'View settings')}
        >
          ⚙
        </button>
        <button
          type="button"
          className={styles['toolBtn']}
          onClick={() => load()}
          title={localize('common.refresh', 'Refresh')}
          aria-label={localize('common.refresh', 'Refresh')}
        >
          ↺
        </button>
        {showSettings && (
          <>
            <div className={styles['settingsBackdrop']} onClick={() => setShowSettings(false)} />
            <div className={styles['settingsPanel']} role="dialog">
              <label className={styles['settingsRow']}>
                <span>{localize('gitGraph.order', 'Order')}</span>
                <select
                  value={settings.order}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      order: e.target.value as GitGraphSettings['order'],
                    }))
                  }
                >
                  <option value="date">{localize('gitGraph.order.date', 'Date')}</option>
                  <option value="author-date">
                    {localize('gitGraph.order.authorDate', 'Author date')}
                  </option>
                  <option value="topo">{localize('gitGraph.order.topology', 'Topology')}</option>
                </select>
              </label>
              <label className={styles['settingsRow']}>
                <input
                  type="checkbox"
                  checked={settings.includeRemotes}
                  onChange={(e) => setSettings((s) => ({ ...s, includeRemotes: e.target.checked }))}
                />
                <span>{localize('gitGraph.showRemoteBranches', 'Show remote branches')}</span>
              </label>
              <label className={styles['settingsRow']}>
                <input
                  type="checkbox"
                  checked={settings.onlyFollowFirstParent}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, onlyFollowFirstParent: e.target.checked }))
                  }
                />
                <span>{localize('gitGraph.onlyFirstParent', 'Only follow first parent')}</span>
              </label>
            </div>
          </>
        )}
      </div>

      {loading && <div className={styles['status']}>{localize('common.loading', 'Loading…')}</div>}
      {error && <div className={styles['error']}>{error}</div>}

      {result && layout && !loading && (
        <div
          className={styles['scrollBody']}
          ref={scrollRef}
          onScroll={(e) => {
            gitGraphViewState.scrollTop = e.currentTarget.scrollTop
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
              {localize('gitGraph.header.commit', 'Commit')}
            </span>
          </div>
          <div className={styles['canvas']} style={{ height: layout.height }}>
            <svg
              className={styles['graphSvg']}
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {layout.paths.map((p, i) => (
                <path
                  key={i}
                  d={p.d}
                  fill="none"
                  stroke={p.isCommitted ? colourOf(p.colour) : '#808080'}
                  strokeWidth={2}
                  {...(p.isCommitted ? {} : { strokeDasharray: '2' })}
                />
              ))}
              {layout.vertices.map((v) => {
                const colour = colourOf(v.colour)
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
                if (v.isStash) {
                  return (
                    <g key={v.id}>
                      <circle cx={v.cx} cy={v.cy} r={4.5} fill={colour} />
                      <circle cx={v.cx} cy={v.cy} r={2} className={styles['stashInner']} />
                    </g>
                  )
                }
                return v.isCurrent ? (
                  <circle
                    key={v.id}
                    cx={v.cx}
                    cy={v.cy}
                    r={4}
                    className={styles['nodeCurrent']}
                    stroke={colour}
                    strokeWidth={2}
                  />
                ) : (
                  <circle key={v.id} cx={v.cx} cy={v.cy} r={4} fill={colour} />
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
              {filteredCommits.map((c, i) => (
                <Fragment key={c.hash}>
                  <CommitRow
                    commit={c}
                    selected={selected.has(c.hash)}
                    headName={result.headName}
                    onRowClick={onRowClick}
                    onCommitMenu={openCommitMenu}
                    onBranchMenu={openBranchMenu}
                    onRemoteMenu={openRemoteMenu}
                    onTagMenu={openTagMenu}
                    onWorktreeMenu={openWorktreeMenu}
                    onOverflowMenu={openOverflowMenu}
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
                onClick={() => setLimit((l) => l + GIT_GRAPH_PAGE_SIZE)}
              >
                {localize('gitGraph.loadMore', 'Load more commits')}
              </button>
            </div>
          )}
        </div>
      )}

      {menu && <GitGraphContextMenu state={menu} onClose={() => setMenu(null)} />}
      {worktreePicker && (
        <GitGraphWorktreePickerDialog
          state={worktreePicker}
          onConfirm={(paths) => void runWorktreeSync(worktreePicker.targetBranch, paths)}
          onClose={() => setWorktreePicker(null)}
        />
      )}
    </div>
  )
}
