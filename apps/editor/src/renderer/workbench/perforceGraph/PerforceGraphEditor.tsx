/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PerforceGraphEditor — main-area tab visualizing the Perforce submitted-change
 *  history as a swim-lane graph (SVG) alongside a per-change row table. Perforce
 *  history is a strictly ordered list of numbered changelists (no local merge
 *  DAG), so the graph is a single lane; it reuses the Git Graph layout engine,
 *  file tree, context menu and stylesheet for a consistent experience.
 *
 *  Clicking a row selects the change and pushes its changed files into the
 *  Commit Changes sidebar view (via the `_workbench.showCommitChanges` bridge);
 *  clicking the synthetic "pending changes" node at the top reveals the SCM main
 *  view. View state is cached in `perforceGraphViewState` so re-activating the
 *  tab is instant.
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
  ICommandService,
  ILoggerService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  StorageScope,
  localize,
  type IEditorInput,
} from '@universe-editor/platform'
import { Globe } from 'lucide-react'
import {
  PerforceGraphCommands,
  type P4GraphChangeDto,
  type P4GraphChangeDetailsDto,
  type P4GraphLoadOptions,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
  type ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'
import { useService, useObservable, useOptionalService } from '../useService.js'
import { IScmService } from '../../services/extensions/ScmService.js'
import { computeGraphLayout, type GraphGrid } from '../../services/gitGraph/graphLayout.js'
import {
  perforceGraphViewState,
  PERFORCE_GRAPH_PAGE_SIZE,
} from '../../services/perforceGraph/perforceGraphViewState.js'
import { scmViewState } from '../scm/scmViewState.js'
import { ShowCommitChangesAction } from '../../actions/commitChangesActions.js'
import { createCommitChangesFollower } from '../scm/commitChanges/graphFollow.js'
import { getOrBuildGraphPayload } from '../scm/commitChanges/graphPayloadCache.js'
import { buildChangePayload } from './commitChangesPayload.js'
import {
  GitGraphContextMenu,
  type GitGraphMenuItem,
  type GitGraphMenuState,
} from '../gitGraph/GitGraphContextMenu.js'
import { useGraphKeyboardNav } from '../gitGraph/useGraphKeyboardNav.js'
import { SendCommitToAgentChatAction } from '../../actions/agentContextActions.js'
import styles from '../gitGraph/GitGraphEditor.module.css'

const ROW_HEIGHT = 24
const GRID: GraphGrid = { x: 14, y: ROW_HEIGHT, offsetX: 12, offsetY: 12 }
/** Id of the synthetic pending-changes node prepended above the latest change. */
const PENDING_ID = '*'

/** Reveal paging cap: stop paging in history after this many extra pages. */
const MAX_REVEAL_PAGES = 20
/** Idle delay before an external change triggers a background reload. */
const AUTO_REFRESH_DEBOUNCE = 500
/** Minimum width (px) a draggable column can shrink to. */
const MIN_COL_WIDTH = 60

/** Storage key for the per-workspace "whole repo vs opened folder" scope toggle. */
const WHOLE_REPO_KEY = 'perforceGraph.wholeRepo'

const PALETTE = ['#0085d9']

function shortId(id: string): string {
  return id === PENDING_ID ? '' : `#${id}`
}

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return ''
  return new Date(unixSeconds * 1000).toLocaleString()
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
        <span className={styles['message']} data-tooltip={change.body || change.message}>
          {change.message}
        </span>
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
  const storage = useService(IStorageService)
  const viewsService = useService(IViewsService)
  const viewDescriptorService = useService(IViewDescriptorService)
  const loggerService = useOptionalService(ILoggerService)
  const logger = useMemo(
    () => loggerService?.createLogger({ id: 'perforceGraph', name: 'Perforce Graph' }) ?? null,
    [loggerService],
  )
  const [result, setResult] = useState<P4GraphLoadResult | null>(
    () => perforceGraphViewState.result,
  )
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => perforceGraphViewState.result === null)
  const [menu, setMenu] = useState<GitGraphMenuState | null>(null)

  const [selection, setSelection] = useState<string[]>(() => perforceGraphViewState.selection)
  // Ref mirror so onRowClick stays referentially stable across selection
  // changes — a fresh callback identity would bust ChangeRow's memo and
  // re-render the whole list before the new highlight paints.
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  // Latest-wins sequence shared by the click bridge and the silent follow: the
  // most recent dispatch supersedes anything still in flight.
  const graphSyncSeqRef = useRef(0)

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
  const [wholeRepo, setWholeRepo] = useState(() => perforceGraphViewState.wholeRepo)

  const queryRef = useRef<P4GraphLoadOptions>({ maxChanges: limit, wholeRepo })
  queryRef.current = { maxChanges: limit, wholeRepo }

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Guards against revalidate clobbering the intermediate pages pulled in by
  // revealCommit.
  const revealingRef = useRef(false)
  // Generation counter over getChanges dispatches (load / revalidate / reveal):
  // continuations only land while still the latest dispatch, so a stale
  // revalidate already in flight when a reveal starts cannot resolve afterwards
  // and clobber the paged-in result (last dispatch wins).
  const fetchSeqRef = useRef(0)
  // Change id the reveal still needs to scroll to, once its row is in the DOM.
  const pendingScrollRef = useRef<string | null>(null)

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
  useEffect(() => {
    perforceGraphViewState.wholeRepo = wholeRepo
  }, [wholeRepo])

  // Persist the scope toggle per-workspace so it's remembered across restarts.
  const wholeRepoLoadedRef = useRef(false)
  useEffect(() => {
    void storage.get<boolean>(WHOLE_REPO_KEY, StorageScope.WORKSPACE).then((stored) => {
      if (typeof stored === 'boolean' && stored !== perforceGraphViewState.wholeRepo) {
        setWholeRepo(stored)
      }
      wholeRepoLoadedRef.current = true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!wholeRepoLoadedRef.current) return
    void storage.set(WHOLE_REPO_KEY, wholeRepo, StorageScope.WORKSPACE)
  }, [wholeRepo, storage])

  const load = useCallback(() => {
    let cancelled = false
    const seq = ++fetchSeqRef.current
    pendingScrollRef.current = null
    setLoading(true)
    setError(null)
    void commands
      .executeCommand<P4GraphLoadResult>(PerforceGraphCommands.getChanges, queryRef.current)
      .then((r) => {
        if (cancelled || seq !== fetchSeqRef.current) return
        setResult(r ?? null)
        setSelection([])
        if (!r)
          setError(
            localize(
              'perforceGraph.unavailable',
              'Perforce Graph is unavailable — is this folder inside a Perforce workspace?',
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
    perforceGraphViewState.refresh = () => load()
    return () => {
      perforceGraphViewState.refresh = null
    }
  }, [load])

  const scrollPendingReveal = useCallback(() => {
    const id = pendingScrollRef.current
    if (!id) return
    // getAttribute comparison instead of a `[data-id="${CSS.escape(id)}"]`
    // selector: attribute-string escape sequences are not honoured by every
    // selector engine (happy-dom in tests).
    const row = scrollRef.current
      ?.querySelectorAll('[data-id]')
      .values()
      .find((el) => el.getAttribute('data-id') === id)
    if (!row) return
    pendingScrollRef.current = null
    row.scrollIntoView({ block: 'center' })
  }, [])

  // A paged-in target row reaches the DOM only after React commits the reveal's
  // setResult — and later still when a search filter was active (the cleared
  // query re-renders at deferred priority). A one-shot rAF would race those
  // commits and silently skip the scroll, so retry after every commit instead.
  useLayoutEffect(scrollPendingReveal)

  // Fetch (or reuse from the shared payload cache) the Commit Changes payload
  // for one changelist. Keyed by client: a changelist's depot contents are
  // immutable, but the local paths the payload carries depend on the client.
  const fetchChangePayload = useCallback(
    (id: string): Promise<ShowCommitChangesPayload | null> => {
      const clientKey = selectedRepo ?? repos[0]?.root ?? ''
      return getOrBuildGraphPayload(`perforce\n${clientKey}\n${id}`, async () => {
        const started = performance.now()
        const details = await commands.executeCommand<P4GraphChangeDetailsDto | null>(
          PerforceGraphCommands.getChangeDetails,
          id,
        )
        logger?.debug(
          `change details #${id} fetched in ${Math.round(performance.now() - started)}ms`,
        )
        return details ? buildChangePayload(details) : null
      })
    },
    [commands, logger, selectedRepo, repos],
  )

  // Silent Commit Changes follow for programmatic reveals (Open in Graph from
  // blame / timeline / the Commit Changes toolbar): the sidebar content tracks
  // the revealed change without opening the container or moving focus.
  // Deliberate row clicks keep the non-silent bridge (they DO reveal it).
  const followCommitChanges = useMemo(
    () =>
      createCommitChangesFollower({
        providerId: 'perforce',
        build: fetchChangePayload,
        apply: (payload) => commands.executeCommand(ShowCommitChangesAction.ID, payload),
        seq: graphSyncSeqRef,
      }),
    [commands, fetchChangePayload],
  )

  // Reveal entry point (timeline / blame / Commit Changes → the observable
  // `perforceGraphViewState.pendingReveal`):
  // select the change and scroll it into view, paging in older history until it
  // is loaded. The loop stops on a hit, on `moreAvailable === false`, or at the
  // page cap (unknown id → silently no-op).
  const revealCommit = useCallback(
    (id: string) => {
      // Requested while the initial load is still in flight: re-queue it
      // instead of racing that load — the load's "fresh load" continuation
      // resets the selection, which would clobber a reveal whose own fetch
      // resolved first. The pendingReveal effect re-dispatches once the first
      // page lands.
      if (result === null) {
        perforceGraphViewState.pendingReveal.set(id, undefined)
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
          for (let i = 0; i < MAX_REVEAL_PAGES && !current?.changes.some((c) => c.id === id); i++) {
            if (current && !current.moreAvailable) break
            nextLimit += PERFORCE_GRAPH_PAGE_SIZE
            const r = await commands.executeCommand<P4GraphLoadResult>(
              PerforceGraphCommands.getChanges,
              { ...queryRef.current, maxChanges: nextLimit },
            )
            // Superseded by a newer dispatch (e.g. a manual refresh) — yield.
            if (seq !== fetchSeqRef.current) return
            if (!r) break
            setResult(r)
            current = r
          }
          if (!current?.changes.some((c) => c.id === id)) return
          if (nextLimit !== limit) setLimit(nextLimit)
          setSelection([id])
          followCommitChanges(id)
          // Scroll now when the row is already rendered (re-reveal of a loaded
          // change commits no state change); otherwise the layout effect picks
          // it up once the row lands in the DOM.
          pendingScrollRef.current = id
          scrollPendingReveal()
        } finally {
          revealingRef.current = false
        }
      })()
    },
    [commands, result, limit, scrollPendingReveal, followCommitChanges],
  )

  useEffect(() => {
    perforceGraphViewState.revealCommit = revealCommit
    return () => {
      perforceGraphViewState.revealCommit = null
    }
  }, [revealCommit])

  // Reveal requests land in the observable pendingReveal (the bridge action
  // writes it, possibly before this instance mounted); consume it reactively,
  // once the first page is in.
  const pendingReveal = useObservable(perforceGraphViewState.pendingReveal)
  useEffect(() => {
    if (pendingReveal === null || result === null) return
    perforceGraphViewState.pendingReveal.set(null, undefined)
    revealCommit(pendingReveal)
  }, [pendingReveal, result, revealCommit])

  // Background reload: refresh data in place without the loading flicker, keeping
  // the current selection when its change still exists.
  const revalidate = useCallback(() => {
    // A reveal in progress drives its own paging; a mid-flight revalidate
    // would clobber the intermediate result and filter out the target.
    if (revealingRef.current) return
    const seq = ++fetchSeqRef.current
    void commands
      .executeCommand<P4GraphLoadResult>(PerforceGraphCommands.getChanges, queryRef.current)
      .then((r) => {
        if (!r || seq !== fetchSeqRef.current) return
        setError(null)
        setResult(r)
        setSelection((prev) => {
          const next = prev.filter((id) => id === PENDING_ID || r.changes.some((c) => c.id === id))
          return next.length === prev.length && next.every((h, i) => h === prev[i]) ? prev : next
        })
      })
      .catch(() => {
        // Transient failure — leave the stale view in place.
      })
  }, [commands])

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

  // Switching scope changes the entire result set, so do a full (loading) reload
  // rather than a silent revalidate. Skip the initial mount.
  const firstScope = useRef(true)
  useEffect(() => {
    if (firstScope.current) {
      firstScope.current = false
      return
    }
    return load()
  }, [wholeRepo, load])

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
      timer = setTimeout(() => revalidate(), AUTO_REFRESH_DEBOUNCE)
    })
    return () => {
      disposable.dispose()
      if (timer) clearTimeout(timer)
    }
  }, [scm, revalidate])

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = perforceGraphViewState.scrollTop
  }, [])

  // Selection entry shared by mouse and keyboard: applies the new selection and
  // pushes the change's files into the Commit Changes view; a deselect or the
  // pending node leaves the sidebar untouched and just supersedes any payload
  // still in flight (latest-wins). This MUST stay event-driven — deriving it
  // from a `selection` effect would fire on tab remount, where the restored
  // selection would steal the sidebar.
  const applySelection = useCallback(
    (next: string[]) => {
      setSelection(next)
      const seq = ++graphSyncSeqRef.current
      if (next.length === 0) return
      const id = next[0]!
      if (id === PENDING_ID) {
        viewsService.openViewContainer('workbench.view.scm')
        viewDescriptorService.setViewCollapsed('workbench.view.scm.main', false)
        return
      }
      void (async () => {
        const payload = await fetchChangePayload(id)
        if (payload === null || seq !== graphSyncSeqRef.current) return
        logger?.debug(`select → show commit changes ref=${payload.commitRef}`)
        await commands.executeCommand(ShowCommitChangesAction.ID, payload)
      })()
    },
    [commands, viewsService, viewDescriptorService, fetchChangePayload, logger],
  )

  // Click semantics on top of applySelection: a plain click shows the change's
  // files; re-clicking the selected row only deselects.
  const onRowClick = useCallback(
    (id: string, _e: MouseEvent) => {
      // Keep the scroll container focused so arrow keys work right after a click.
      scrollRef.current?.focus()
      const current = selectionRef.current
      applySelection(current.length === 1 && current[0] === id ? [] : [id])
    },
    [applySelection],
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
          run: () => void navigator.clipboard?.writeText(change.body || change.message),
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
        body: '',
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

  const layout = useMemo(() => {
    if (!result) return null
    const isFiltering = deferredQuery.trim() !== ''
    const filteredIdSet = isFiltering ? new Set(filteredChanges.map((c) => c.id)) : null
    const commits = filteredChanges.map((c) => ({
      hash: c.id,
      parents: filteredIdSet ? c.parents.filter((p) => filteredIdSet.has(p)) : c.parents,
      isUncommitted: c.id === PENDING_ID,
    }))
    return computeGraphLayout(commits, result.head, { grid: GRID })
  }, [result, filteredChanges, deferredQuery])

  const graphWidth = layout?.width ?? GRID.offsetX * 2
  const selected = useMemo(() => new Set(selection), [selection])

  // Ctrl+Enter on the selected row: a changelist row has exactly one menu
  // target (the change itself), so the menu opens directly, anchored at the row.
  const openRowMenu = useCallback(
    (id: string) => {
      const change = filteredChanges.find((c) => c.id === id)
      if (!change || id === PENDING_ID) return
      const rowEl = scrollRef.current
        ?.querySelectorAll('[data-id]')
        .values()
        .find((el) => el.getAttribute('data-id') === id)
      const rect = rowEl?.getBoundingClientRect()
      openChangeMenu(change, {
        clientX: (rect?.left ?? 0) + 16,
        clientY: rect?.bottom ?? 0,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as MouseEvent)
    },
    [filteredChanges, openChangeMenu],
  )

  const rowKeys = useMemo(() => filteredChanges.map((c) => c.id), [filteredChanges])
  const selectFromKeyboard = useCallback((id: string) => applySelection([id]), [applySelection])
  const onRowsKeyDown = useGraphKeyboardNav({
    rows: rowKeys,
    selectionRef,
    select: selectFromKeyboard,
    openMenu: openRowMenu,
    scrollRef,
    rowAttribute: 'data-id',
    rowHeight: ROW_HEIGHT,
  })

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
            data-tooltip={localize('perforceGraph.client', 'Client')}
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
          className={`${styles['toolBtn']} ${wholeRepo ? styles['toolBtnActive'] : ''}`}
          onClick={() => setWholeRepo((v) => !v)}
          data-tooltip={
            wholeRepo
              ? localize('perforceGraph.scope.showFolder', 'Show current folder changes only')
              : localize('perforceGraph.scope.showWholeRepo', 'Show whole repository changes')
          }
          aria-label={localize('perforceGraph.scope.toggle', 'Toggle repository scope')}
          aria-pressed={wholeRepo}
        >
          <Globe size={14} />
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
      </div>

      {loading && <div className={styles['status']}>{localize('common.loading', 'Loading…')}</div>}
      {error && <div className={styles['error']}>{error}</div>}

      {result && layout && !loading && (
        <div
          className={styles['scrollBody']}
          ref={scrollRef}
          tabIndex={0}
          role="listbox"
          aria-label={localize('perforceGraph.changeList', 'Changes')}
          data-testid="perforceGraph-scrollBody"
          onKeyDown={onRowsKeyDown}
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
              {filteredChanges.map((c) => (
                <ChangeRow
                  key={c.id}
                  change={c}
                  selected={selected.has(c.id)}
                  onRowClick={onRowClick}
                  onChangeMenu={openChangeMenu}
                />
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
    </div>
  )
}
