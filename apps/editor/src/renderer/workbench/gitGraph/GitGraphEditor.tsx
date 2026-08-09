/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GitGraphEditor — main-area tab visualizing the git commit DAG as a swim-lane
 *  graph (SVG) alongside a per-commit row table. Layout comes from graphLayout.ts;
 *  the SVG overlay and the rows share a fixed row height so nodes line up.
 *
 *  Clicking a row selects the commit and pushes its changed files into the
 *  Commit Changes sidebar view (via the `_workbench.showCommitChanges` bridge);
 *  Ctrl/Cmd-clicking a second row compares the two commits there. Clicking the
 *  uncommitted node reveals the SCM main view. View state (loaded commits,
 *  selection, scroll) is cached in `gitGraphViewState` so re-activating the tab
 *  is instant.
 *--------------------------------------------------------------------------------------------*/

import {
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
} from 'react'
import {
  autorun,
  CommandsRegistry,
  Emitter,
  ICommandService,
  IDialogService,
  ILoggerService,
  INotificationService,
  IProgressService,
  IQuickInputService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  observableValue,
  ProgressLocation,
  Severity,
  StorageScope,
  localize,
  type IEditorInput,
} from '@universe-editor/platform'
import {
  GitGraphCommands,
  type GitGraphCommitDto,
  type GitGraphCommitDetailsDto,
  type GitGraphFileChangeDto,
  type GitGraphLoadOptions,
  type GitGraphLoadResult,
  type GitGraphRepoDto,
  type GitGraphWorktreeDto,
  type GitGraphWorktreeSyncResult,
  type ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'
import {
  useService,
  useObservable,
  useCommandRegistered,
  useOptionalService,
} from '../useService.js'
import { IScmService } from '../../services/extensions/ScmService.js'
import { computeGraphLayout, type GraphGrid } from '../../services/gitGraph/graphLayout.js'
import {
  GIT_GRAPH_OUTLINE_LANGUAGE_ID,
  GraphOutlineRegistry,
  type GraphOutlineCommit,
  type IGraphOutlineController,
} from '../../services/gitGraph/graphOutline.js'
import {
  gitGraphViewState,
  GIT_GRAPH_PAGE_SIZE,
  type GitGraphSettings,
} from '../../services/gitGraph/gitGraphViewState.js'
import { scmViewState } from '../scm/scmViewState.js'
import {
  FocusCommitChangesAction,
  ShowCommitChangesAction,
} from '../../actions/commitChangesActions.js'
import { createCommitChangesFollower } from '../scm/commitChanges/graphFollow.js'
import { getOrBuildGraphPayload } from '../scm/commitChanges/graphPayloadCache.js'
import { buildCommitPayload, buildComparePayload } from './commitChangesPayload.js'
import {
  GitGraphContextMenu,
  type GitGraphMenuItem,
  type GitGraphMenuState,
} from './GitGraphContextMenu.js'
import { useGraphKeyboardNav } from './useGraphKeyboardNav.js'
import { useFullCommitMessages } from './useFullCommitMessages.js'
import { usePersistedGraphSelection } from './usePersistedGraphSelection.js'
import {
  GitGraphWorktreePickerDialog,
  type GitGraphWorktreePickerState,
} from './GitGraphWorktreePickerDialog.js'
import {
  GitGraphBranchPickerDialog,
  type GitGraphBranchPickerState,
} from './GitGraphBranchPickerDialog.js'
import { SendCommitToAgentChatAction } from '../../actions/agentContextActions.js'
import styles from './GitGraphEditor.module.css'

const ROW_HEIGHT = 24
const GRID: GraphGrid = { x: 14, y: ROW_HEIGHT, offsetX: 12, offsetY: 12 }
/** Hash of the synthetic working-tree node prepended above HEAD. */
const UNCOMMITTED_HASH = '*'
/** Rows that must not be persisted as the last focused commit. */
const PERSISTENCE_EXCLUDED_IDS = [UNCOMMITTED_HASH]
/** Idle delay before an external git change triggers a background reload. */
const AUTO_REFRESH_DEBOUNCE = 500

/** Reveal paging cap: stop paging in history after this many extra pages. */
const MAX_REVEAL_PAGES = 20
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

function resolveEffectiveRepoRoot(
  repos: readonly GitGraphRepoDto[],
  selectedRepo: string | null,
): string | null {
  if (repos.length === 0) return selectedRepo
  if (selectedRepo && repos.some((repo) => repo.root === selectedRepo)) return selectedRepo
  return repos[0]?.root ?? null
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
          data-tooltip={entry.title}
          onContextMenu={entry.onMenu}
        >
          {entry.text}
        </span>
      ))}
      {hidden.length > 0 && (
        <button
          type="button"
          className={styles['badgeOverflow']}
          data-tooltip={hidden.map((e) => e.menuLabel).join('\n')}
          onClick={(e) => onOverflowMenu(hidden, e)}
        >
          +{hidden.length}
        </button>
      )}
    </span>
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
  fullMessage,
  onRowClick,
  onCommitMenu,
  onBranchMenu,
  onRemoteMenu,
  onTagMenu,
  onWorktreeMenu,
  onOverflowMenu,
  onMessageHover,
}: {
  commit: GitGraphCommitDto
  selected: boolean
  headName: string | null
  /** Lazily fetched full commit message; falls back to the subject. */
  fullMessage: string | undefined
  onRowClick: (hash: string, e: MouseEvent) => void
  onCommitMenu: (commit: GitGraphCommitDto, e: MouseEvent) => void
  onBranchMenu: (name: string, e: MouseEvent) => void
  onRemoteMenu: (name: string, e: MouseEvent) => void
  onTagMenu: (name: string, e: MouseEvent) => void
  onWorktreeMenu: (worktree: GitGraphWorktreeDto, e: MouseEvent) => void
  onOverflowMenu: (entries: RefEntry[], e: MouseEvent) => void
  onMessageHover: (hash: string) => void
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
        <span
          className={styles['message']}
          data-tooltip={fullMessage ?? commit.message}
          onMouseEnter={() => onMessageHover(commit.hash)}
        >
          {commit.message}
        </span>
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
  const notification = useService(INotificationService)
  // Optional so unit tests without a progress binding still render the editor.
  const progressService = useOptionalService(IProgressService)
  const quickInput = useOptionalService(IQuickInputService)
  const loggerService = useOptionalService(ILoggerService)
  const logger = useMemo(
    () => loggerService?.createLogger({ id: 'gitGraph', name: 'Git Graph' }) ?? null,
    [loggerService],
  )
  const scm = useService(IScmService)
  const storage = useService(IStorageService)
  const viewsService = useService(IViewsService)
  const viewDescriptorService = useService(IViewDescriptorService)
  const [result, setResult] = useState<GitGraphLoadResult | null>(() => gitGraphViewState.result)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => gitGraphViewState.result === null)
  const [menu, setMenu] = useState<GitGraphMenuState | null>(null)
  const [worktreePicker, setWorktreePicker] = useState<GitGraphWorktreePickerState | null>(null)
  const [branchPicker, setBranchPicker] = useState<
    (GitGraphBranchPickerState & { onPick: (branch: string) => void }) | null
  >(null)

  // Selected commit(s): one hash to show in the Commit Changes view, two to compare.
  const [selection, setSelection] = useState<string[]>(() => gitGraphViewState.selection)
  // Ref mirror so onRowClick stays referentially stable across selection
  // changes — a fresh callback identity would bust CommitRow's memo and
  // re-render the whole list before the new highlight paints.
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  // Latest-wins sequence shared by the click bridge and the silent follow: the
  // most recent dispatch supersedes anything still in flight.
  const graphSyncSeqRef = useRef(0)

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
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Guards against revalidate clobbering the intermediate pages pulled in by
  // revealCommit (auto-refresh fires independently of the reveal loop).
  const revealingRef = useRef(false)
  // Generation counter over getCommits dispatches (load / revalidate / reveal):
  // continuations only land while still the latest dispatch, so a stale
  // revalidate already in flight when a reveal starts cannot resolve afterwards
  // and clobber the paged-in result (last dispatch wins).
  const fetchSeqRef = useRef(0)
  // Commit hash the reveal still needs to scroll to, once its row is in the DOM.
  const pendingScrollRef = useRef<string | null>(null)

  useEffect(() => {
    gitGraphViewState.focusSearch = () => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    return () => {
      gitGraphViewState.focusSearch = null
    }
  }, [])

  // Layout effect on purpose: EditorGroupView's activation focus runs in a
  // layout effect as well, so a passive registration would miss the first
  // GitGraphEditorInput.focus() call on open.
  const focusRequestedRef = useRef(false)
  useLayoutEffect(() => {
    gitGraphViewState.focusRows = () => {
      // The first open arrives while the loading state is still up and the
      // listbox isn't in the DOM yet — defer to the effect below.
      focusRequestedRef.current = true
      scrollRef.current?.focus()
    }
    return () => {
      gitGraphViewState.focusRows = null
    }
  }, [])

  useLayoutEffect(() => {
    if (!focusRequestedRef.current || !scrollRef.current) return
    focusRequestedRef.current = false
    scrollRef.current.focus()
  })

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
    const seq = ++fetchSeqRef.current
    pendingScrollRef.current = null
    setLoading(true)
    setError(null)
    void commands
      .executeCommand<GitGraphLoadResult>(GitGraphCommands.getCommits, queryRef.current)
      .then((r) => {
        if (cancelled || seq !== fetchSeqRef.current) return
        setResult(r ?? null)
        // A fresh load invalidates the previous selection.
        setSelection([])
        if (!r)
          setError(
            localize(
              'gitGraph.unavailable',
              'Git Graph is unavailable — is this folder a git repository?',
            ),
          )
      })
      .catch((e: unknown) => {
        if (!cancelled && seq === fetchSeqRef.current)
          setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [commands])

  useEffect(() => {
    gitGraphViewState.refresh = () => load()
    return () => {
      gitGraphViewState.refresh = null
    }
  }, [load])

  const scrollPendingReveal = useCallback(() => {
    const hash = pendingScrollRef.current
    if (!hash) return
    // getAttribute comparison instead of a `[data-hash="${CSS.escape(hash)}"]`
    // selector: attribute-string escape sequences are not honoured by every
    // selector engine (happy-dom in tests).
    const row = scrollRef.current
      ?.querySelectorAll('[data-hash]')
      .values()
      .find((el) => el.getAttribute('data-hash') === hash)
    if (!row) return
    pendingScrollRef.current = null
    row.scrollIntoView({ block: 'center' })
  }, [])

  // A paged-in target row reaches the DOM only after React commits the reveal's
  // setResult — and later still when a search filter was active (the cleared
  // query re-renders at deferred priority). A one-shot rAF would race those
  // commits and silently skip the scroll, so retry after every commit instead.
  useLayoutEffect(scrollPendingReveal)

  const discoverEffectiveRepoRoot = useCallback(async (): Promise<string | null> => {
    const current = resolveEffectiveRepoRoot(repos, selectedRepo)
    if (current) return current

    const discovered = await commands.executeCommand<GitGraphRepoDto[]>(GitGraphCommands.getRepos)
    if (!discovered || discovered.length === 0) return null

    setRepos(discovered)
    gitGraphViewState.repos = discovered
    return resolveEffectiveRepoRoot(discovered, selectedRepo)
  }, [commands, repos, selectedRepo])

  // Fetch (or reuse from the shared payload cache) the Commit Changes payload
  // for one commit. Backed by the extension's getCommitDetails (two git
  // spawns), so repeat visits and concurrent follow/click requests coalesce.
  const fetchCommitPayload = useCallback(
    async (hash: string): Promise<ShowCommitChangesPayload | null> => {
      const repoRoot = await discoverEffectiveRepoRoot()
      if (!repoRoot) return null
      return getOrBuildGraphPayload(`git\n${repoRoot}\n${hash}`, async () => {
        const started = performance.now()
        const details = await commands.executeCommand<GitGraphCommitDetailsDto | null>(
          GitGraphCommands.getCommitDetails,
          hash,
        )
        logger?.debug(
          `commit details ${shortHash(hash)} fetched in ${Math.round(performance.now() - started)}ms`,
        )
        return details ? buildCommitPayload(repoRoot, details) : null
      })
    },
    [commands, discoverEffectiveRepoRoot, logger],
  )

  // Full commit messages (subject + body) are fetched on demand: hovering a
  // message prefetches it for the tooltip, the Copy action awaits it.
  const fullMessages = useFullCommitMessages(
    useCallback(
      (hash: string) =>
        commands
          .executeCommand<GitGraphCommitDetailsDto | null>(GitGraphCommands.getCommitDetails, hash)
          .then((details) => details?.body ?? null),
      [commands],
    ),
  )
  const onMessageHover = useCallback(
    (hash: string) => {
      if (hash === UNCOMMITTED_HASH) return
      void fullMessages.load(hash)
    },
    [fullMessages],
  )

  // Silent Commit Changes follow for programmatic reveals (Open in Graph from
  // blame / timeline / the Commit Changes toolbar): the sidebar content tracks
  // the revealed commit without opening the container or moving focus.
  // Deliberate row clicks keep the non-silent bridge (they DO reveal it).
  const followCommitChanges = useMemo(
    () =>
      createCommitChangesFollower({
        providerId: 'git',
        build: fetchCommitPayload,
        apply: (payload) => commands.executeCommand(ShowCommitChangesAction.ID, payload),
        seq: graphSyncSeqRef,
      }),
    [commands, fetchCommitPayload],
  )

  // Reveal entry point (timeline / blame / Commit Changes → the observable
  // `gitGraphViewState.pendingReveal`): select the
  // commit and scroll it into view, paging in older history until the commit is
  // loaded. Synchronous per-page awaits keep the ordering simple; the loop stops
  // on a hit, on `moreAvailable === false`, or at the page cap (unknown hash →
  // silently no-op, matching reveal semantics elsewhere).
  const revealCommit = useCallback(
    (hash: string) => {
      // Requested while the initial load is still in flight: re-queue it
      // instead of racing that load — the load's "fresh load" continuation
      // resets the selection, which would clobber a reveal whose own fetch
      // resolved first. The pendingReveal effect re-dispatches once the first
      // page lands.
      if (result === null) {
        gitGraphViewState.pendingReveal.set(hash, undefined)
        return
      }
      void (async () => {
        revealingRef.current = true
        const seq = ++fetchSeqRef.current
        try {
          // A filter would hide the target row.
          setSearchQuery('')
          let current = result
          let nextLimit = limit
          for (
            let i = 0;
            i < MAX_REVEAL_PAGES && !current?.commits.some((c) => c.hash === hash);
            i++
          ) {
            if (current && !current.moreAvailable) break
            nextLimit += GIT_GRAPH_PAGE_SIZE
            const r = await commands.executeCommand<GitGraphLoadResult>(
              GitGraphCommands.getCommits,
              { ...queryRef.current, maxCommits: nextLimit },
            )
            // Superseded by a newer dispatch (e.g. a manual refresh) — yield.
            if (seq !== fetchSeqRef.current) return
            if (!r) break
            setResult(r)
            current = r
          }
          if (!current?.commits.some((c) => c.hash === hash)) return
          if (nextLimit !== limit) setLimit(nextLimit)
          setSelection([hash])
          followCommitChanges(hash)
          // Scroll now when the row is already rendered (re-reveal of a loaded
          // commit commits no state change); otherwise the layout effect picks
          // it up once the row lands in the DOM.
          pendingScrollRef.current = hash
          scrollPendingReveal()
        } finally {
          revealingRef.current = false
        }
      })()
    },
    [commands, result, limit, scrollPendingReveal, followCommitChanges],
  )

  useEffect(() => {
    gitGraphViewState.revealCommit = revealCommit
    return () => {
      gitGraphViewState.revealCommit = null
    }
  }, [revealCommit])

  // Reveal requests land in the observable pendingReveal (the bridge action
  // writes it, possibly before this instance mounted); consume it reactively,
  // once the first page is in.
  const pendingReveal = useObservable(gitGraphViewState.pendingReveal)
  useEffect(() => {
    if (pendingReveal === null || result === null) return
    gitGraphViewState.pendingReveal.set(null, undefined)
    revealCommit(pendingReveal)
  }, [pendingReveal, result, revealCommit])

  // Background reload: refresh data in place without the loading flicker, keeping
  // the current selection when its commit still exists. Used by auto-refresh and
  // when re-activating a cached tab (stale-while-revalidate).
  const revalidate = useCallback(() => {
    // A reveal in progress drives its own paging; a mid-flight auto-refresh
    // would clobber the intermediate result and filter out the target.
    if (revealingRef.current) return
    // The auto-refresh autorun (below) reacts to the SCM provider appearing,
    // which the git extension does BEFORE registering the git-graph commands —
    // querying here would warn "command not found" and drop the refresh.
    if (!CommandsRegistry.getCommand(GitGraphCommands.getCommits)) return
    const seq = ++fetchSeqRef.current
    void commands
      .executeCommand<GitGraphLoadResult>(GitGraphCommands.getCommits, queryRef.current)
      .then((r) => {
        if (!r || seq !== fetchSeqRef.current) return
        setError(null)
        setResult(r)
        setSelection((prev) => {
          const next = prev.filter(
            (h) => h === UNCOMMITTED_HASH || r.commits.some((c) => c.hash === h),
          )
          // Keep the previous array reference when unchanged so memoised rows
          // don't re-render needlessly.
          return next.length === prev.length && next.every((h, i) => h === prev[i]) ? prev : next
        })
      })
      .catch(() => {
        // A transient failure (e.g. host restarting) leaves the stale view in place.
      })
  }, [commands])

  // The git extension registers the git-graph commands only after it activates,
  // which races a startup-restored tab: executing earlier warns "command not
  // found" and resolves undefined, which `load` would misread as "unavailable".
  // Gate the initial queries on registration; the loading state simply persists
  // until the extension is up.
  const graphCommandsReady = useCommandRegistered(GitGraphCommands.getCommits)

  // Initial load only when nothing is cached; a cached tab revalidates in the
  // background so re-activating it shows fresh data without a flash. If a
  // non-default repo was selected previously, re-assert it on the extension side
  // first (its active-repo state may have reset across an app restart).
  useEffect(() => {
    if (!graphCommandsReady) return
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
  }, [commands, load, revalidate, graphCommandsReady])

  // Discover the repositories the view can switch between (main repo + submodules).
  useEffect(() => {
    if (!graphCommandsReady) return
    void commands.executeCommand<GitGraphRepoDto[]>(GitGraphCommands.getRepos).then((r) => {
      if (r) {
        setRepos(r)
        gitGraphViewState.repos = r
      }
    })
  }, [commands, graphCommandsReady])

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
      timer = setTimeout(() => revalidate(), AUTO_REFRESH_DEBOUNCE)
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

  // Selection entry shared by mouse and keyboard: applies the new selection and
  // pushes the commit (or two-commit comparison) into the Commit Changes view;
  // a deselect or the uncommitted node leaves the sidebar untouched and just
  // supersedes any payload still in flight (latest-wins). This MUST stay
  // event-driven — deriving it from a `selection` effect would fire on tab
  // remount, where the restored selection would steal the sidebar from whatever
  // the user is viewing.
  const applySelection = useCallback(
    (next: string[]) => {
      setSelection(next)
      const seq = ++graphSyncSeqRef.current
      if (next.length === 0) return
      if (next[0] === UNCOMMITTED_HASH) {
        viewsService.openViewContainer('workbench.view.scm')
        viewDescriptorService.setViewCollapsed('workbench.view.scm.main', false)
        return
      }
      void (async () => {
        let payload: ShowCommitChangesPayload | null
        if (next.length === 2) {
          const repoRoot = await discoverEffectiveRepoRoot()
          if (!repoRoot) return
          const from = next[0]!
          const to = next[1]!
          payload = await getOrBuildGraphPayload(`git\n${repoRoot}\n${from}..${to}`, async () => {
            const files = await commands.executeCommand<GitGraphFileChangeDto[]>(
              GitGraphCommands.compareCommits,
              from,
              to,
            )
            return files ? buildComparePayload(repoRoot, from, to, files) : null
          })
        } else {
          payload = await fetchCommitPayload(next[0]!)
        }
        if (payload === null || seq !== graphSyncSeqRef.current) return
        logger?.debug(`select → show commit changes ref=${payload.commitRef}`)
        await commands.executeCommand(ShowCommitChangesAction.ID, payload)
      })()
    },
    [
      commands,
      viewsService,
      viewDescriptorService,
      discoverEffectiveRepoRoot,
      fetchCommitPayload,
      logger,
    ],
  )

  // Click semantics on top of applySelection: a plain click shows the commit's
  // changes, Ctrl/Cmd+clicking a second row shows the comparison, re-clicking
  // the selected row only deselects.
  const onRowClick = useCallback(
    (hash: string, e: MouseEvent) => {
      // Keep the scroll container focused so arrow keys work right after a click.
      scrollRef.current?.focus()
      const current = selectionRef.current
      const multi = e.ctrlKey || e.metaKey
      if (multi && current.length >= 1 && current[0] !== hash) applySelection([current[0]!, hash])
      else if (!multi && current.length === 1 && current[0] === hash) applySelection([])
      else applySelection([hash])
    },
    [applySelection],
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

  // Prompt for a target branch, then cherry-pick `hash` onto it. The branch list
  // is fetched lazily on menu selection so the graph doesn't pay for it upfront.
  const openCherryPickToBranch = useCallback(
    (hash: string) => {
      void (async () => {
        const branches = await commands.executeCommand<string[]>(GitGraphCommands.getBranches)
        if (!branches || branches.length === 0) {
          notification.notify({
            severity: Severity.Info,
            message: localize('gitGraph.cherryPickToBranch.noBranches', 'No branches available.'),
          })
          return
        }
        setBranchPicker({
          title: localize('gitGraph.cherryPickToBranch.title', 'Cherry-pick {hash} to branch', {
            hash: shortHash(hash),
          }),
          branches,
          ...(result?.headName ? { exclude: result.headName } : {}),
          onPick: (branch) => {
            setBranchPicker(null)
            runOp(GitGraphCommands.cherryPickToBranch, hash, branch)
          },
        })
      })()
    },
    [commands, notification, result?.headName, runOp],
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
          label: localize('gitGraph.cherryPickToBranch', 'Cherry-pick to branch…'),
          run: () => openCherryPickToBranch(hash),
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
          run: async () => {
            const body = await fullMessages.load(hash)
            await navigator.clipboard?.writeText(body ?? commit.message)
          },
        },
        { kind: 'sep' },
        {
          kind: 'item',
          label: localize('gitGraph.sendToAgentChat', 'Send to Agent Chat'),
          run: () =>
            void commands.executeCommand(SendCommitToAgentChatAction.ID, {
              hash,
              message: commit.message,
            }),
        },
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [commands, dialog, runOp, openCherryPickToBranch, fullMessages],
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
        {
          kind: 'item',
          label: localize('gitGraph.copyBranchName', 'Copy branch name'),
          run: () => void navigator.clipboard?.writeText(name),
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
            const localName = local?.trim()
            if (!localName) return
            const branches = await commands.executeCommand<string[]>(GitGraphCommands.getBranches)
            if (!branches?.includes(localName)) {
              runOp(GitGraphCommands.checkoutRemote, name, localName)
              return
            }
            const offer = await dialog.confirm({
              message: localize(
                'gitGraph.checkoutRemote.exists',
                "Branch '{name}' already exists locally.",
                { name: localName },
              ),
              detail: localize(
                'gitGraph.checkoutRemote.offerReset',
                "You can reset it to the latest commit of '{remote}' instead.",
                { remote: name },
              ),
              primaryButton: localize('gitGraph.checkoutRemote.resetToRemote', 'Reset to Remote…'),
            })
            if (!offer.confirmed) return
            const sure = await dialog.confirm({
              message: localize('gitGraph.resetToRemote.confirm', "Reset '{name}' to '{remote}'?", {
                name: localName,
                remote: name,
              }),
              detail: localize(
                'gitGraph.resetToRemote.detail',
                'Local commits that are not on the remote will be discarded.',
              ),
              primaryButton: localize('gitGraph.resetToRemote.button', 'Reset'),
              type: 'warning',
            })
            if (sure.confirmed) runOp(GitGraphCommands.resetBranchToRemote, name, localName)
          },
        },
        {
          kind: 'item',
          label: localize('gitGraph.copyBranchName', 'Copy branch name'),
          run: () => void navigator.clipboard?.writeText(name),
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
    [commands, dialog, runOp],
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
  // reload the graph. Dirty worktrees are always skipped by the extension side.
  // The extension syncs the worktrees concurrently in one command call, so while
  // it runs we surface a sticky spinner notification instead of staying silent.
  const runWorktreeSync = useCallback(
    async (targetBranch: string, selectedPaths: string[], force: boolean) => {
      setWorktreePicker(null)
      const selected = allWorktrees.filter((wt) => selectedPaths.includes(wt.path))
      const refs = selected.map((wt) => ({ path: wt.path, name: wt.name }))
      const execute = () =>
        commands.executeCommand<GitGraphWorktreeSyncResult>(
          GitGraphCommands.syncWorktrees,
          targetBranch,
          refs,
          force,
        )
      const summary = progressService
        ? await progressService.withProgress(
            {
              location: ProgressLocation.Notification,
              title: localize(
                'gitGraph.worktree.sync.progress',
                'Syncing {count} worktree(s) to {branch}…',
                { count: refs.length, branch: targetBranch },
              ),
              source: 'git-graph',
            },
            execute,
          )
        : await execute()
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
    [allWorktrees, commands, dialog, progressService, revalidate],
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
            run: () =>
              setWorktreePicker({ targetBranch: branch, candidates: others, force: false }),
          },
          {
            kind: 'item',
            label: localize(
              'gitGraph.worktree.forceSyncToThis',
              'Force sync worktrees to {branch}…',
              {
                branch,
              },
            ),
            danger: true,
            run: () => setWorktreePicker({ targetBranch: branch, candidates: others, force: true }),
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

  const isFiltering = deferredQuery.trim() !== ''

  const layout = useMemo(() => {
    if (!result) return null
    const filteredHashSet = isFiltering ? new Set(filteredCommits.map((c) => c.hash)) : null
    const commits = filteredCommits.map((c) => ({
      hash: c.hash,
      parents: filteredHashSet ? c.parents.filter((p) => filteredHashSet.has(p)) : c.parents,
      isStash: c.stash !== null,
      isUncommitted: c.hash === UNCOMMITTED_HASH,
    }))
    return computeGraphLayout(commits, result.head, {
      grid: GRID,
      onlyFollowFirstParent: settings.onlyFollowFirstParent,
    })
  }, [result, filteredCommits, settings.onlyFollowFirstParent, isFiltering])

  const graphWidth = layout?.width ?? GRID.offsetX * 2
  // Lane collapse only applies while searching; the normal view always renders
  // the full swim-lane graph no matter how many lanes it needs.
  const isCompact = isFiltering && (layout?.laneCount ?? 0) > 6
  const effectiveGraphWidth = isCompact ? GRID.offsetX * 2 : graphWidth
  const selected = useMemo(() => new Set(selection), [selection])

  // Ctrl+Enter on the selected row: open the same context menu a right-click
  // would show, anchored at the row. A row can carry several menu targets (the
  // commit itself plus worktree / branch / tag / remote badges); when more than
  // one applies, a QuickPick disambiguates first.
  const openRowMenu = useCallback(
    (hash: string) => {
      const commit = filteredCommits.find((c) => c.hash === hash)
      if (!commit || hash === UNCOMMITTED_HASH) return
      const rowEl = scrollRef.current
        ?.querySelectorAll('[data-hash]')
        .values()
        .find((el) => el.getAttribute('data-hash') === hash)
      const rect = rowEl?.getBoundingClientRect()
      const anchor = {
        clientX: (rect?.left ?? 0) + 16,
        clientY: rect?.bottom ?? 0,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as MouseEvent
      const contexts = [
        {
          label: localize('gitGraph.ref.commit', 'Commit {hash}', { hash: shortHash(hash) }),
          open: () => openCommitMenu(commit, anchor),
        },
        ...commit.worktrees.map((wt) => ({
          label: localize('gitGraph.ref.worktree', 'Worktree {name}', { name: wt.name }),
          open: () => openWorktreeMenu(wt, anchor),
        })),
        ...commit.heads.map((h) => ({
          label: localize('gitGraph.ref.branch', 'Branch {name}', { name: h }),
          open: () => openBranchMenu(h, anchor),
        })),
        ...commit.tags.map((t) => ({
          label: localize('gitGraph.ref.tag', 'Tag {name}', { name: t.name }),
          open: () => openTagMenu(t.name, anchor),
        })),
        ...commit.remotes.map((r) => ({
          label: localize('gitGraph.ref.remote', 'Remote {name}', { name: r.name }),
          open: () => openRemoteMenu(r.name, anchor),
        })),
      ]
      if (contexts.length === 1 || !quickInput) {
        contexts[0]!.open()
        return
      }
      void quickInput
        .pick(
          contexts.map((c, i) => ({ id: String(i), label: c.label, context: c })),
          {
            placeholder: localize(
              'gitGraph.pickMenuContext',
              'Show context menu for which target?',
            ),
          },
        )
        .then((picked) => picked?.context.open())
    },
    [
      filteredCommits,
      quickInput,
      openCommitMenu,
      openWorktreeMenu,
      openBranchMenu,
      openTagMenu,
      openRemoteMenu,
    ],
  )

  const rowKeys = useMemo(() => filteredCommits.map((c) => c.hash), [filteredCommits])
  const selectFromKeyboard = useCallback((hash: string) => applySelection([hash]), [applySelection])
  const openCommitChanges = useCallback(
    () => void commands.executeCommand(FocusCommitChangesAction.ID),
    [commands],
  )

  usePersistedGraphSelection({
    storageKey: 'gitGraph.lastSelectedCommit',
    selection,
    effectiveRepo: resolveEffectiveRepoRoot(repos, selectedRepo),
    result,
    pendingReveal: gitGraphViewState.pendingReveal,
    excludedIds: PERSISTENCE_EXCLUDED_IDS,
    defaultRowId: rowKeys.find((k) => k !== UNCOMMITTED_HASH) ?? null,
    selectDefault: selectFromKeyboard,
  })
  const onRowsKeyDown = useGraphKeyboardNav({
    rows: rowKeys,
    selectionRef,
    select: selectFromKeyboard,
    openMenu: openRowMenu,
    openCommitChanges,
    scrollRef,
    rowAttribute: 'data-hash',
    rowHeight: ROW_HEIGHT,
  })

  // Go to Symbol / Outline bridge: publish the loaded commits (the unfiltered
  // display list, so a search filter can't shrink the symbol list) and select /
  // scroll rows on demand. selectCommit deliberately reuses applySelection so
  // accepting a symbol carries full row-click semantics — pushing COMMIT
  // CHANGES and expanding the SCM sidebar.
  const outlineCommits = useMemo(
    () => observableValue<readonly GraphOutlineCommit[]>('gitGraph.outlineCommits', []),
    [],
  )
  useEffect(() => {
    outlineCommits.set(
      displayCommits.map((c) =>
        c.hash === UNCOMMITTED_HASH
          ? { hash: c.hash, label: c.message, detail: '', pending: true }
          : {
              hash: c.hash,
              label: c.message,
              detail: `${shortHash(c.hash)} · ${c.author} · ${formatDate(c.date)}`,
            },
      ),
      undefined,
    )
  }, [outlineCommits, displayCommits])

  const onDidChangeOutlineSelection = useMemo(() => new Emitter<void>(), [])
  useEffect(() => {
    onDidChangeOutlineSelection.fire()
  }, [onDidChangeOutlineSelection, selection])

  useEffect(() => {
    const controller: IGraphOutlineController = {
      commits: outlineCommits,
      selectCommit: (hash) => {
        // A search filter would hide the target row.
        setSearchQuery('')
        applySelection([hash])
        pendingScrollRef.current = hash
        scrollPendingReveal()
        scrollRef.current?.focus()
      },
      scrollToCommit: (hash) => {
        pendingScrollRef.current = hash
        scrollPendingReveal()
      },
      getSelectedHash: () => {
        const current = selectionRef.current
        return current.length === 1 ? current[0] : undefined
      },
      onDidChangeSelection: onDidChangeOutlineSelection.event,
    }
    GraphOutlineRegistry.register(GIT_GRAPH_OUTLINE_LANGUAGE_ID, controller)
    return () => {
      GraphOutlineRegistry.unregister(GIT_GRAPH_OUTLINE_LANGUAGE_ID, controller)
    }
  }, [outlineCommits, onDidChangeOutlineSelection, applySelection, scrollPendingReveal])

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
            data-tooltip={localize('gitGraph.repository', 'Repository')}
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
          data-tooltip={
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
          data-tooltip={localize('gitGraph.viewSettings', 'View settings')}
          aria-label={localize('gitGraph.viewSettings', 'View settings')}
        >
          ⚙
        </button>
        <button
          type="button"
          className={styles['toolBtn']}
          onClick={() => load()}
          data-tooltip={localize('common.refresh', 'Refresh')}
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
          tabIndex={0}
          role="listbox"
          aria-label={localize('gitGraph.commitList', 'Commits')}
          data-testid="gitGraph-scrollBody"
          onKeyDown={onRowsKeyDown}
          onScroll={(e) => {
            gitGraphViewState.scrollTop = e.currentTarget.scrollTop
          }}
        >
          <div className={styles['header']}>
            <span className={styles['graphSpacer']} style={{ width: effectiveGraphWidth }} />
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
              width={effectiveGraphWidth}
              height={layout.height}
              aria-hidden="true"
            >
              {!isCompact &&
                layout.paths.map((p, i) => (
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
                const cx = isCompact ? GRID.offsetX : v.cx
                const colour = colourOf(v.colour)
                if (v.isUncommitted) {
                  return (
                    <circle
                      key={v.id}
                      cx={cx}
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
                      <circle cx={cx} cy={v.cy} r={4.5} fill={colour} />
                      <circle cx={cx} cy={v.cy} r={2} className={styles['stashInner']} />
                    </g>
                  )
                }
                return v.isCurrent ? (
                  <circle
                    key={v.id}
                    cx={cx}
                    cy={v.cy}
                    r={4}
                    className={styles['nodeCurrent']}
                    stroke={colour}
                    strokeWidth={2}
                  />
                ) : (
                  <circle key={v.id} cx={cx} cy={v.cy} r={4} fill={colour} />
                )
              })}
            </svg>

            <div
              className={styles['rows']}
              style={
                {
                  '--graph-width': `${effectiveGraphWidth}px`,
                  '--col-author': `${columnWidths.author}px`,
                  '--col-date': `${columnWidths.date}px`,
                } as CSSProperties
              }
            >
              {filteredCommits.map((c) => (
                <CommitRow
                  key={c.hash}
                  commit={c}
                  selected={selected.has(c.hash)}
                  headName={result.headName}
                  fullMessage={fullMessages.get(c.hash)}
                  onRowClick={onRowClick}
                  onCommitMenu={openCommitMenu}
                  onBranchMenu={openBranchMenu}
                  onRemoteMenu={openRemoteMenu}
                  onTagMenu={openTagMenu}
                  onWorktreeMenu={openWorktreeMenu}
                  onOverflowMenu={openOverflowMenu}
                  onMessageHover={onMessageHover}
                />
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

      {menu && (
        <GitGraphContextMenu
          state={menu}
          onClose={() => {
            setMenu(null)
            // The menu lives in a portal; closing it drops focus to <body>
            // otherwise, which would silently break arrow-key navigation.
            scrollRef.current?.focus()
          }}
        />
      )}
      {worktreePicker && (
        <GitGraphWorktreePickerDialog
          state={worktreePicker}
          onConfirm={(paths) =>
            void runWorktreeSync(worktreePicker.targetBranch, paths, worktreePicker.force)
          }
          onClose={() => setWorktreePicker(null)}
        />
      )}
      {branchPicker && (
        <GitGraphBranchPickerDialog
          state={branchPicker}
          onConfirm={branchPicker.onPick}
          onClose={() => setBranchPicker(null)}
        />
      )}
    </div>
  )
}
