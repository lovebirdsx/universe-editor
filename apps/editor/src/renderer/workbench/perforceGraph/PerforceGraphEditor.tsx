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
 *  view. View state is cached in `perforceGraphViewState` (bucketed by input id)
 *  so re-activating the tab is instant.
 *
 *  A scoped input (`PerforceGraphEditorInput` carrying a `scope`) shows history
 *  for a single file/folder: the query is fixed to that path, the whole-repo
 *  toggle and client switcher are hidden, and nothing (scope toggle, last
 *  selected change) is persisted — it is a one-shot view.
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
  Emitter,
  ICommandService,
  ILoggerService,
  INotificationService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  observableValue,
  Severity,
  StorageScope,
  localize,
  type IEditorInput,
} from '@universe-editor/platform'
import { Globe, RefreshCw } from 'lucide-react'
import {
  PerforceGraphCommands,
  type P4GraphChangeDto,
  type P4GraphChangeDetailsDto,
  type P4GraphHaveChangeResult,
  type P4GraphLoadOptions,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
  type P4GraphSyncPoint,
  type P4GraphSyncRequest,
  type P4GraphSyncScopeDto,
  type ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'
import {
  createKeyboardContextMenuEvent,
  isKeyboardContextMenu,
  Spinner,
} from '@universe-editor/workbench-ui'
import { useService, useObservable, useOptionalService } from '../useService.js'
import { IScmService, scmProviderPathKey } from '../../services/extensions/ScmService.js'
import { computeGraphLayout, type GraphGrid } from '../../services/gitGraph/graphLayout.js'
import {
  PERFORCE_GRAPH_OUTLINE_LANGUAGE_ID,
  GraphOutlineRegistry,
  type GraphOutlineCommit,
  type IGraphOutlineController,
} from '../../services/gitGraph/graphOutline.js'
import {
  GLOBAL_PERFORCE_GRAPH_KEY,
  getPerforceGraphViewState,
  PERFORCE_GRAPH_PAGE_SIZE,
} from '../../services/perforceGraph/perforceGraphViewState.js'
import { PerforceGraphEditorInput } from '../../services/editor/PerforceGraphEditorInput.js'
import { scmViewState } from '../scm/scmViewState.js'
import {
  FocusCommitChangesAction,
  ShowCommitChangesAction,
} from '../../actions/commitChangesActions.js'
import { createCommitChangesFollower } from '../scm/commitChanges/graphFollow.js'
import { getOrBuildGraphPayload } from '../scm/commitChanges/graphPayloadCache.js'
import { buildChangePayload } from './commitChangesPayload.js'
import {
  GitGraphContextMenu,
  type GitGraphMenuItem,
  type GitGraphMenuState,
} from '../gitGraph/GitGraphContextMenu.js'
import {
  PerforceGraphSyncDialog,
  type PerforceGraphSyncDialogState,
} from './PerforceGraphSyncDialog.js'
import { useGraphKeyboardNav } from '../gitGraph/useGraphKeyboardNav.js'
import { usePersistedGraphSelection } from '../gitGraph/usePersistedGraphSelection.js'
import { SendCommitToAgentChatAction } from '../../actions/agentContextActions.js'
import styles from '../gitGraph/GitGraphEditor.module.css'

const ROW_HEIGHT = 24
const GRID: GraphGrid = { x: 14, y: ROW_HEIGHT, offsetX: 12, offsetY: 12 }
/** Id of the synthetic pending-changes node prepended above the latest change. */
const PENDING_ID = '*'
/** Rows that must not be persisted as the last focused change. */
const PERSISTENCE_EXCLUDED_IDS = [PENDING_ID]

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

/**
 * Elapsed time of a sync-point probe, as shown next to its button. One decimal:
 * the interesting range is "instant" to "a minute", and tenths are what makes a
 * 200ms answer legible as having happened at all.
 */
function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** A changelist number as the graph orders rows by, or undefined for a row that
 *  is not a changelist (`*` is the synthetic pending node). */
function changeNumber(id: string): number | undefined {
  const n = Number(id)
  return Number.isFinite(n) ? n : undefined
}

/**
 * The row holding the sync point, which is not always the row NAMED by it.
 *
 * A record made by a get on a wider scope answers for every scope under it, and
 * the changelist it names need not have touched this one at all — so a scoped
 * history can be missing that row entirely. The row it does contain is the
 * newest change at or below the point, and badging THAT one is exact rather than
 * a fallback: rows are strictly descending, so this row is the newest change in
 * the whole history the sync covers (anything newer sits above it, and anything
 * between it and the point would be above it too and would have been found
 * first).
 */
function syncPointRowOf(
  changes: readonly P4GraphChangeDto[],
  pointId: string,
): { id: string; exact: boolean } | null {
  for (const c of changes) {
    if (c.id === pointId) return { id: c.id, exact: true }
  }
  const target = changeNumber(pointId)
  if (target === undefined) return null
  for (const c of changes) {
    const n = changeNumber(c.id)
    if (n !== undefined && n <= target) return { id: c.id, exact: false }
  }
  return null
}

/**
 * Whether the loaded window rules `id` out for good: rows come newest-first and
 * a page is always a prefix of that order, so once one of them sits BELOW the
 * wanted changelist number, the changelist can never show up — it would have
 * been above what is already loaded. Ids that are not changelist numbers (the
 * synthetic pending node) are ruled out on the same grounds: no row carries them.
 *
 * Without this the reveal loop runs to its page cap looking for a changelist the
 * history cannot contain (a wider record's point, e.g.), pulling the entire
 * history in — tens of pages for a scope that never touched it.
 */
function ruledOut(changes: readonly P4GraphChangeDto[], id: string): boolean {
  const target = changeNumber(id)
  if (target === undefined) return true
  return changes.some((c) => {
    const n = changeNumber(c.id)
    return n !== undefined && n < target
  })
}

/**
 * The toolbar line's tooltip. Provenance comes first because a recorded answer
 * and a queried one mean genuinely different things about what is NOT reflected:
 * a record only knows the gets this editor ran, while a query is the server's
 * answer as of that moment. The caveats say when the changelist is only an upper
 * bound — the line itself shows a bare `#4521` either way, so this is the only
 * place the difference can be told.
 */
function syncPointTooltip(point: P4GraphSyncPoint): string {
  const when = formatDate(point.at / 1000)
  const parts = [
    point.source === 'query'
      ? localize(
          'perforceGraph.syncPoint.fromQuery',
          'Answered by Perforce at {time}. Changes newer than this are not synced yet.',
          { time: when },
        )
      : localize(
          'perforceGraph.syncPoint.fromSync',
          'Recorded at {time}, when this editor pulled that changelist. Syncs made outside the editor since then are not reflected — use Query Sync Point to re-check.',
          { time: when },
        ),
  ]
  if (point.widerScope) {
    parts.push(
      localize(
        'perforceGraph.syncPoint.widerScope',
        'The record covers a wider scope, so this is an upper bound: this scope may have been pulled less far.',
      ),
    )
  }
  if (point.partial) {
    parts.push(
      localize(
        'perforceGraph.syncPoint.partial',
        'That pull left some files behind (modified, open for edit, or needing a merge), so this is an upper bound.',
      ),
    )
  }
  return parts.join(' ')
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
  isHave,
  haveTooltip,
  onRowClick,
  onChangeMenu,
}: {
  change: P4GraphChangeDto
  selected: boolean
  /** This row is the row the sync point sits on — usually the changelist the
   *  point names, but for a point that changed nothing under this scope it is
   *  the newest change the sync covers (`syncPointRowOf`). A bare boolean, not
   *  the id or the whole result: the memo above only earns its keep if the prop
   *  is stable for rows the badge doesn't move between. */
  isHave: boolean
  /** The badge's tooltip, which differs between those two cases. */
  haveTooltip: string
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
        {isHave && (
          // Sits where Git Graph puts a branch badge — left of the message, right
          // of the lane. Reuses the shared badge styles; `.badge` alone is only
          // the ellipsis base, so the `.badgeTag` modifier supplies the pill.
          <span className={styles['refs']}>
            <span className={`${styles['badge']} ${styles['badgeTag']}`} data-tooltip={haveTooltip}>
              {localize('perforceGraph.haveBadge', 'Synced')}
            </span>
          </span>
        )}
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

export function PerforceGraphEditor({ input }: { input: IEditorInput }) {
  // The component is always mounted with a PerforceGraphEditorInput in
  // production; the instanceof guard keeps the module-level global bucket as the
  // fallback for a wide/legacy input (and the renderer-dom tests that pass a
  // bare `{}`), instead of silently keying an `undefined` bucket.
  const inputId = input instanceof PerforceGraphEditorInput ? input.id : GLOBAL_PERFORCE_GRAPH_KEY
  const scope = input instanceof PerforceGraphEditorInput ? input.scope : undefined
  const view = useMemo(() => getPerforceGraphViewState(inputId), [inputId])
  const commands = useService(ICommandService)
  const scm = useService(IScmService)
  const storage = useService(IStorageService)
  const viewsService = useService(IViewsService)
  const viewDescriptorService = useService(IViewDescriptorService)
  // Optional: the toast is the only thing that needs it, and the probe itself
  // must still work in a container that has no notification service (tests).
  const notification = useOptionalService(INotificationService)
  const loggerService = useOptionalService(ILoggerService)
  const logger = useMemo(
    () => loggerService?.createLogger({ id: 'perforceGraph', name: 'Perforce Graph' }) ?? null,
    [loggerService],
  )
  const [result, setResult] = useState<P4GraphLoadResult | null>(() => view.result)
  // The local sync point, kept OUT of `result` on purpose: it arrives from its
  // own commands (the ledger read, or a server query), while three call sites
  // replace `result` wholesale — merging a late answer into every one of them
  // would drop the badge the first time one was missed.
  const [syncPoint, setSyncPoint] = useState<P4GraphSyncPoint | null>(() => view.syncPoint)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => view.result === null)
  const [menu, setMenu] = useState<GitGraphMenuState | null>(null)
  const [syncDialog, setSyncDialog] = useState<PerforceGraphSyncDialogState | null>(null)

  const [selection, setSelection] = useState<string[]>(() => view.selection)
  // Ref mirror so onRowClick stays referentially stable across selection
  // changes — a fresh callback identity would bust ChangeRow's memo and
  // re-render the whole list before the new highlight paints.
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  // Latest-wins sequence shared by the click bridge and the silent follow: the
  // most recent dispatch supersedes anything still in flight.
  const graphSyncSeqRef = useRef(0)

  const [limit, setLimit] = useState(() => view.limit)
  const [columnWidths, setColumnWidths] = useState(() => ({
    ...view.columnWidths,
  }))
  const [repos, setRepos] = useState<P4GraphRepoDto[]>(() => view.repos)
  const [selectedRepo, setSelectedRepo] = useState<string | null>(() => view.selectedRepo)
  const [searchQuery, setSearchQuery] = useState(() => view.searchQuery)
  const deferredQuery = useDeferredValue(searchQuery)
  const [wholeRepo, setWholeRepo] = useState(() => view.wholeRepo)

  const queryRef = useRef<P4GraphLoadOptions>(
    scope !== undefined
      ? { maxChanges: limit, scopePaths: scope.paths }
      : { maxChanges: limit, wholeRepo },
  )
  queryRef.current =
    scope !== undefined
      ? { maxChanges: limit, scopePaths: scope.paths }
      : { maxChanges: limit, wholeRepo }

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
  // Generation counter over have-point probes. Deliberately NOT `fetchSeqRef`:
  // that one also advances for revealCommit's paging, and a paging read returns
  // the same scope — dropping the badge for it would flicker the row marker off
  // and on for a page the badge still describes. Only a scope change (load) or a
  // newer probe invalidates one in flight.
  const haveSeqRef = useRef(0)
  // Change id the reveal still needs to scroll to, once its row is in the DOM.
  const pendingScrollRef = useRef<string | null>(null)
  // Live state of the sync-point probe the toolbar is showing. Its cost is the
  // size of the scope (tens of seconds on a wide workspace), so the click needs
  // an answer of its own: the icon spins in place and the elapsed clock runs
  // next to it, then the number stays up briefly so a fast answer is still
  // legible as "that click ran".
  //
  // `failed` is the third ending: the probe came back without an answer (p4
  // timed out or errored), which must not read as "answered, nothing changed".
  const [syncQuery, setSyncQuery] = useState<{ ms: number; done: boolean; failed: boolean } | null>(
    null,
  )
  const syncQueryTickRef = useRef<number | undefined>(undefined)
  const syncQueryClearRef = useRef<number | undefined>(undefined)
  const syncQueryStartedRef = useRef<number | undefined>(undefined)
  // A user-issued query is out. Only one at a time: a second press cannot answer
  // anything the first will not, and it would spend a second whole-scope p4
  // round trip (tens of seconds) to prove it.
  const queryInFlightRef = useRef(false)
  // True while this instance is unmounted. A late answer can still reach
  // `stopSyncQueryClock` — it must not arm a fresh 2.5s hold timer then.
  const clockDisposedRef = useRef(false)
  // The last query answered "nothing in this scope is synced". Distinct from
  // "never asked": one is an answer with no changelist to name, the other is a
  // gap — the tooltip must not claim ignorance over a reply we just received.
  const [queriedEmpty, setQueriedEmpty] = useState(false)
  useEffect(() => {
    view.focusSearch = () => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    return () => {
      view.focusSearch = null
    }
  }, [view])

  // Layout effect on purpose: EditorGroupView's activation focus runs in a
  // layout effect as well, so a passive registration would miss the first
  // PerforceGraphEditorInput.focus() call on open.
  const focusRequestedRef = useRef(false)
  useLayoutEffect(() => {
    view.focusRows = () => {
      // The first open arrives while the loading state is still up and the
      // listbox isn't in the DOM yet — defer to the effect below.
      focusRequestedRef.current = true
      scrollRef.current?.focus()
    }
    return () => {
      view.focusRows = null
    }
  }, [view])

  useLayoutEffect(() => {
    if (!focusRequestedRef.current || !scrollRef.current) return
    focusRequestedRef.current = false
    scrollRef.current.focus()
  })

  // Mirror state into the module-level store so it survives unmount.
  useEffect(() => {
    view.result = result
  }, [result, view])
  useEffect(() => {
    view.syncPoint = syncPoint
  }, [syncPoint, view])
  useEffect(() => {
    view.selection = selection
  }, [selection, view])
  useEffect(() => {
    view.limit = limit
  }, [limit, view])
  useEffect(() => {
    view.columnWidths = columnWidths
  }, [columnWidths, view])
  useEffect(() => {
    view.selectedRepo = selectedRepo
  }, [selectedRepo, view])
  useEffect(() => {
    view.searchQuery = searchQuery
  }, [searchQuery, view])
  useEffect(() => {
    view.wholeRepo = wholeRepo
  }, [wholeRepo, view])

  // Persist the scope toggle per-workspace so it's remembered across restarts.
  // Scoped tabs skip both the read and the write: the toggle is fixed there.
  const wholeRepoLoadedRef = useRef(false)
  useEffect(() => {
    if (scope !== undefined) return
    void storage.get<boolean>(WHOLE_REPO_KEY, StorageScope.WORKSPACE).then((stored) => {
      if (typeof stored === 'boolean' && stored !== view.wholeRepo) {
        setWholeRepo(stored)
      }
      wholeRepoLoadedRef.current = true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (scope !== undefined) return
    if (!wholeRepoLoadedRef.current) return
    void storage.set(WHOLE_REPO_KEY, wholeRepo, StorageScope.WORKSPACE)
  }, [wholeRepo, storage, scope])

  // Error text for a load result, or null when it is a normal listing. Shared by
  // the initial load and the silent revalidate — a revalidate that clears the
  // error unconditionally would turn a multi-client scope back into "0 changes".
  const loadErrorFor = useCallback(
    (r: P4GraphLoadResult | null): string | null => {
      if (r?.error === 'multiClient') {
        // The extension already surfaced an error notification; the tab needs a
        // distinct empty state — reading this as "0 changes" would be misleading.
        return localize(
          'perforceGraph.scopedMultiClientEmpty',
          'The selected paths are not in one Perforce workspace, so their history cannot be merged.',
        )
      }
      if (r) return null
      return scope !== undefined
        ? localize('perforceGraph.scopedEmpty', 'No submitted changes affect this path.')
        : localize(
            'perforceGraph.unavailable',
            'Perforce Graph is unavailable — is this folder inside a Perforce workspace?',
          )
    },
    [scope],
  )

  // Ask for the local sync point of the scope `queryRef` currently holds.
  //
  // The ledger answers first, and for free: every get this editor ran recorded
  // where it landed, so the common case costs one synchronous message and zero
  // p4 calls. That is the whole point — the old probe (`p4 changes <scope>#have`)
  // costs the SIZE of the scope, tens of seconds over a wide workspace, and was
  // re-paid on every load and scope switch.
  //
  // The server is asked only when the ledger has nothing:
  //   - a scoped history (a file / folder / merged selection) is cheap there
  //     (~200-340ms), so it keeps the old automatic behaviour;
  //   - the whole graph is not (up to ~40s), so it shows "not known" and waits
  //     for the user to press the query button. That button is also the ONLY way
  //     to see a `p4 sync` done outside the editor — a recorded answer says
  //     nothing about those, which is exactly what the toolbar text now says.
  //
  // A failure answers nothing and leaves the badge as it was (the extension logs
  // why); a stale answer is dropped rather than pinned onto a different scope.
  const startSyncQueryClock = useCallback((): void => {
    clearInterval(syncQueryTickRef.current)
    clearTimeout(syncQueryClearRef.current)
    const startedAt = Date.now()
    syncQueryStartedRef.current = startedAt
    queryInFlightRef.current = true
    setSyncQuery({ ms: 0, done: false, failed: false })
    logger?.debug('sync point query clock started')
    // 100ms is under the eye's threshold for "this is moving" and costs nothing:
    // the probe runs in the extension host, so this only repaints one number.
    syncQueryTickRef.current = window.setInterval(() => {
      setSyncQuery({ ms: Date.now() - startedAt, done: false, failed: false })
    }, 100)
  }, [logger])

  /** Stop the clock and hold the final number on screen for a beat — on a fast
   *  scope the answer arrives before the tick is readable, and "0.2s" appearing
   *  is the only thing that says the click was acted on at all. `failed` keeps
   *  the number but marks it as "no answer came", which is not the same ending. */
  const stopSyncQueryClock = useCallback(
    (failed = false): void => {
      clearInterval(syncQueryTickRef.current)
      syncQueryTickRef.current = undefined
      const startedAt = syncQueryStartedRef.current
      // No clock means no user query to release: an automatic probe answers here
      // too, and it must not clear a claim it never took.
      if (startedAt === undefined) return
      queryInFlightRef.current = false
      // Unmounted while the probe was out: report nothing, arm nothing. Logged
      // because the visible symptom (a spinner that never comes back) is the same
      // one a broken clock reports, and this is what tells the two apart.
      if (clockDisposedRef.current) {
        logger?.debug('sync point query clock dropped: the editor is unmounted')
        return
      }
      logger?.debug(
        `sync point query clock ${failed ? 'failed' : 'landed'} after ${Date.now() - startedAt}ms`,
      )
      setSyncQuery({ ms: Date.now() - startedAt, done: true, failed })
      syncQueryClearRef.current = window.setTimeout(() => setSyncQuery(null), 2500)
    },
    [logger],
  )

  /** Drop the clock without reporting anything — the answer it was timing is
   *  no longer wanted (the scope changed under it). */
  const cancelSyncQueryClock = useCallback((): void => {
    clearInterval(syncQueryTickRef.current)
    clearTimeout(syncQueryClearRef.current)
    syncQueryTickRef.current = undefined
    syncQueryStartedRef.current = undefined
    queryInFlightRef.current = false
    setSyncQuery(null)
    logger?.debug('sync point query clock cancelled: the answer it timed is not wanted any more')
  }, [logger])

  useEffect(() => {
    // The setup MUST reset what the cleanup latches: dev's StrictMode runs
    // mount → cleanup → mount again on this same instance, so a flag left set by
    // the dry run would make every later `stopSyncQueryClock` a no-op — clearing
    // the interval but never landing `done`, which freezes the spinner and the
    // number on screen forever while the answer itself still applies.
    clockDisposedRef.current = false
    return () => {
      clockDisposedRef.current = true
      clearInterval(syncQueryTickRef.current)
      clearTimeout(syncQueryClearRef.current)
    }
  }, [])

  const refreshSyncPoint = useCallback(
    (mode: 'ledger' | 'query' = 'ledger'): void => {
      // A user query supersedes everything in flight — it is the newest truth
      // there is — so it takes the next sequence. A ledger read does NOT: bumping
      // would let it throw away an answer the user is waiting on (a p4 round trip
      // that can run for tens of seconds) whenever a load lands between the click
      // and the reply, which is exactly what a scope toggle and a get-through-the-
      // graph both do. Reads still HONOUR the sequence — a load that changed the
      // scope invalidates them up front — so the only thing they lose is the
      // power to cancel someone else's answer. If a get records a point while a
      // query is out, that query can still land last with the older point; the
      // next load or revalidate reads the ledger again and settles it.
      const askServer = (force: boolean, seq: number) => {
        // Only a user-issued query drives the clock and claims the "one at a
        // time" slot: the automatic probe of a scoped history is cheap and comes
        // and goes on its own, so a spinner for it would be noise the user never
        // asked for — and would make the held number mean two different things.
        if (force) startSyncQueryClock()
        logger?.debug(
          `sync point #${seq} asked of the server (force=${force}, paths=${
            queryRef.current.scopePaths?.length ?? 'whole-repo'
          })`,
        )
        void commands
          .executeCommand<P4GraphHaveChangeResult>(PerforceGraphCommands.getHaveChange, {
            ...queryRef.current,
            force,
          })
          .then((r) => {
            // A superseded probe must not stop the clock: the newer press is the
            // one whose answer the user is waiting for, and its own reply (or the
            // scope change that discarded it) ends the run.
            if (seq !== haveSeqRef.current) {
              logger?.debug(`sync point #${seq} dropped: superseded by #${haveSeqRef.current}`)
              return
            }
            stopSyncQueryClock(!r || r.failed)
            // `failed` means the probe could not answer — not "nothing synced".
            // Keeping the previous point is the better lie: only a sync moves it.
            if (!r || r.failed) return
            // `id: null` IS an answer ("nothing here is synced"), and showing it
            // as the unknown marker is honest: there is no row to badge and no
            // changelist to name or jump to. It is not the same as never having
            // asked, so the marker's tooltip says which one this is.
            setQueriedEmpty(r.id === null)
            setSyncPoint(
              r.id === null
                ? null
                : { id: r.id, source: 'query', at: Date.now(), widerScope: false, partial: false },
            )
          })
          .catch(() => {
            // Annotation only — the previous answer (or no badge) stands.
            if (seq === haveSeqRef.current) {
              stopSyncQueryClock(true)
            }
          })
      }
      if (mode === 'query') {
        if (queryInFlightRef.current) {
          // A second press cannot answer anything the first will not, and it
          // would spend a whole-scope p4 round trip (tens of seconds) on it.
          notification?.notify({
            severity: Severity.Info,
            message: localize(
              'perforceGraph.syncPoint.alreadyQuerying',
              'A sync point query is already running — it will answer as soon as Perforce replies.',
            ),
          })
          return
        }
        // Taking the next sequence comes AFTER the refusal: a press that is
        // turned away must not invalidate the answer it was told to wait for.
        askServer(true, ++haveSeqRef.current)
        return
      }
      const seq = haveSeqRef.current
      // Whether a user query is out while this read resolves. A read dispatched
      // during one carries pre-query content (the extension only writes the
      // ledger once the query command returns), so it must not land on top of
      // the answer the user is waiting for — the sequence check cannot catch it,
      // since a read that starts after the query takes the same sequence.
      const racedByQuery = queryInFlightRef.current
      void commands
        .executeCommand<P4GraphSyncPoint | null>(
          PerforceGraphCommands.getSyncPoint,
          queryRef.current,
        )
        .then((p) => {
          if (seq !== haveSeqRef.current || racedByQuery) return
          if (p) {
            setSyncPoint(p)
            setQueriedEmpty(false)
            return
          }
          if (scope !== undefined) {
            askServer(false, seq)
            return
          }
          setSyncPoint(null)
        })
        .catch(() => {
          if (seq !== haveSeqRef.current || racedByQuery) return
          setSyncPoint(null)
        })
    },
    [commands, scope, notification, logger, startSyncQueryClock, stopSyncQueryClock],
  )

  const load = useCallback(() => {
    let cancelled = false
    const seq = ++fetchSeqRef.current
    // A different scope's sync point must not label this list while its own
    // answer is in flight; the loading state covers the list, so clearing here
    // is invisible. An in-flight probe is abandoned with it — its answer is
    // dropped below, so its clock must not keep spinning for an answer that can
    // no longer be shown.
    haveSeqRef.current++
    cancelSyncQueryClock()
    setSyncPoint(null)
    // A different scope has not been asked about, whatever the last one answered.
    setQueriedEmpty(false)
    pendingScrollRef.current = null
    setLoading(true)
    setError(null)
    void commands
      .executeCommand<P4GraphLoadResult>(PerforceGraphCommands.getChanges, queryRef.current)
      .then((r) => {
        if (cancelled || seq !== fetchSeqRef.current) return
        setResult(r ?? null)
        setSelection([])
        setError(loadErrorFor(r ?? null))
        // Deliberately the LEDGER, not a server query: a reload is not a reason
        // to pay a whole-workspace probe again — that is the cost this whole
        // mechanism exists to remove. A scoped history still queries, because
        // the ledger is empty and its probe is cheap.
        refreshSyncPoint()
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
  }, [commands, loadErrorFor, refreshSyncPoint, cancelSyncQueryClock])

  useEffect(() => {
    view.refresh = () => load()
    return () => {
      view.refresh = null
    }
  }, [load, view])

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
  // Also keyed by the filter: a merged-history tab narrows the payload to the
  // selected paths, so two tabs showing the same changelist must not share one
  // cached payload (whoever built first would pin the other's file list).
  const clientRoot = result?.clientRoot
  // Only a MULTI-path tab filters. A single file/folder tab keeps showing the
  // whole changelist, exactly as before this feature existed.
  const filterPaths = scope !== undefined && scope.paths.length > 1 ? scope.paths : undefined
  const scopeSig = useMemo(
    () =>
      filterPaths ? filterPaths.map((p) => `${p.isDirectory ? 'd' : 'f'}:${p.path}`).join('|') : '',
    [filterPaths],
  )
  const fetchChangePayload = useCallback(
    (id: string): Promise<ShowCommitChangesPayload | null> => {
      const clientKey = clientRoot ?? selectedRepo ?? repos[0]?.root ?? ''
      return getOrBuildGraphPayload(`perforce\n${clientKey}\n${scopeSig}\n${id}`, async () => {
        const started = performance.now()
        const details = await commands.executeCommand<P4GraphChangeDetailsDto | null>(
          PerforceGraphCommands.getChangeDetails,
          id,
          { ...(clientRoot !== undefined ? { clientRoot } : {}) },
        )
        logger?.debug(
          `change details #${id} fetched in ${Math.round(performance.now() - started)}ms`,
        )
        return details
          ? buildChangePayload(details, {
              ...(filterPaths !== undefined ? { scopePaths: filterPaths } : {}),
              ...(clientRoot !== undefined ? { clientRoot } : {}),
            })
          : null
      })
    },
    [commands, logger, selectedRepo, repos, clientRoot, filterPaths, scopeSig],
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
  // `view.pendingReveal`):
  // select the change and scroll it into view, paging in older history until it
  // is loaded. The loop stops on a hit, on a window that has dropped below the
  // target (it can no longer appear — see `ruledOut`), on `moreAvailable ===
  // false`, or at the page cap.
  //
  // `onMiss: 'below'` is the sync point's own jump: its changelist may not have
  // touched this scope at all, and then there is no row to land on and never
  // will be. Rather than paging to the cap and doing nothing, it lands on the
  // row the sync actually covers and says so — the toolbar's point and the badge
  // then agree on where this scope stands.
  const revealCommit = useCallback(
    (id: string, options?: { onMiss?: 'below' }): void => {
      // Requested while the initial load is still in flight: re-queue it
      // instead of racing that load — the load's "fresh load" continuation
      // resets the selection, which would clobber a reveal whose own fetch
      // resolved first. The pendingReveal effect re-dispatches once the first
      // page lands.
      if (result === null) {
        view.pendingReveal.set(id, undefined)
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
          let found = current.changes.some((c) => c.id === id)
          let stopped = ruledOut(current.changes, id)
          let pages = 0
          for (let i = 0; i < MAX_REVEAL_PAGES && !found && !stopped; i++) {
            if (!current.moreAvailable) break
            nextLimit += PERFORCE_GRAPH_PAGE_SIZE
            const r = await commands.executeCommand<P4GraphLoadResult>(
              PerforceGraphCommands.getChanges,
              { ...queryRef.current, maxChanges: nextLimit },
            )
            // Superseded by a newer dispatch (e.g. a manual refresh) — yield.
            if (seq !== fetchSeqRef.current) return
            if (!r) break
            pages++
            setResult(r)
            current = r
            found = r.changes.some((c) => c.id === id)
            stopped = ruledOut(r.changes, id)
          }
          const landing = found
            ? id
            : options?.onMiss === 'below'
              ? (syncPointRowOf(current.changes, id)?.id ?? null)
              : null
          logger?.debug(
            `reveal #${id}: ${found ? 'hit' : landing !== null ? `miss, landed on #${landing}` : 'not in this history'} ` +
              `after ${pages} page(s)${stopped ? ', the window dropped below it' : ''}`,
          )
          if (landing === null) {
            // Silent no-ops are how a drained history reads as "nothing
            // happened"; say which of the two misses this is and stop.
            notification?.notify({
              severity: Severity.Info,
              message:
                options?.onMiss === 'below'
                  ? localize(
                      'perforceGraph.syncPoint.notInScope',
                      'Sync point #{point} changed nothing under this scope, and every change here is newer than it — nothing in this history has been synced yet.',
                      { point: id },
                    )
                  : localize(
                      'perforceGraph.reveal.missing',
                      '#{id} is not in this history — it may not touch what this tab shows.',
                      { id },
                    ),
            })
            return
          }
          if (landing !== id) {
            notification?.notify({
              severity: Severity.Info,
              message: localize(
                'perforceGraph.syncPoint.landedBelow',
                'Sync point #{point} changed nothing under this scope, so it has no row here. Showing #{row} — the newest change that the sync does cover.',
                { point: id, row: landing },
              ),
            })
          }
          if (nextLimit !== limit) setLimit(nextLimit)
          setSelection([landing])
          followCommitChanges(landing)
          // Scroll now when the row is already rendered (re-reveal of a loaded
          // change commits no state change); otherwise the layout effect picks
          // it up once the row lands in the DOM.
          pendingScrollRef.current = landing
          scrollPendingReveal()
        } finally {
          revealingRef.current = false
        }
      })()
    },
    [
      commands,
      result,
      limit,
      scrollPendingReveal,
      followCommitChanges,
      view.pendingReveal,
      notification,
      logger,
    ],
  )

  useEffect(() => {
    view.revealCommit = revealCommit
    return () => {
      view.revealCommit = null
    }
  }, [revealCommit, view])

  // Reveal requests land in the observable pendingReveal (the bridge action
  // writes it, possibly before this instance mounted); consume it reactively,
  // once the first page is in.
  const pendingReveal = useObservable(view.pendingReveal)
  useEffect(() => {
    if (pendingReveal === null || result === null) return
    view.pendingReveal.set(null, undefined)
    revealCommit(pendingReveal)
  }, [pendingReveal, result, revealCommit, view])

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
        setError(loadErrorFor(r))
        setResult(r)
        setSelection((prev) => {
          const next = prev.filter((id) => id === PENDING_ID || r.changes.some((c) => c.id === id))
          return next.length === prev.length && next.every((h, i) => h === prev[i]) ? prev : next
        })
        // This is where a get through the editor shows up: the extension writes
        // the ledger before the sync command resolves, so re-reading it here
        // picks up the new sync point without any server round trip.
        refreshSyncPoint()
      })
      .catch(() => {
        // Transient failure — leave the stale view in place.
      })
  }, [commands, loadErrorFor, refreshSyncPoint])

  // A get started from the graph (row menu, force-get, the scope dialog) must
  // revalidate itself: a plain get rewrites have revisions without touching
  // `p4 opened`, so the SCM observable that drives the auto-refresh may never
  // emit and the sync badge would stay on the old row. Unconditional on the
  // outcome — a cancelled sync still left files on disk, and re-reading a
  // "nothing to do" get is free (the stale entries are behind the cache TTL).
  const getThenRevalidate = useCallback(
    (id: string, ...args: unknown[]): void => {
      void Promise.resolve(commands.executeCommand(id, ...args))
        .catch(() => {
          // The sync path reports its own failures; this only keeps the chain
          // from ending in an unhandled rejection.
        })
        .then(() => revalidate())
    },
    [commands, revalidate],
  )

  useEffect(() => {
    const start = (): (() => void) | undefined => {
      if (view.result) {
        revalidate()
        return undefined
      }
      return load()
    }
    // A scoped tab never touches the shared client selection (setRepo writes the
    // global graph state); its client is implied by the scope path.
    if (scope !== undefined) return start()
    const initialRepo = view.selectedRepo
    if (initialRepo) {
      void commands.executeCommand(PerforceGraphCommands.setRepo, initialRepo).then(start)
      return
    }
    return start()
  }, [commands, load, revalidate, view, scope])

  useEffect(() => {
    void commands.executeCommand<P4GraphRepoDto[]>(PerforceGraphCommands.getRepos).then((r) => {
      if (r) {
        setRepos(r)
        view.repos = r
      }
    })
  }, [commands, view])

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
    // A scoped tab's client is fixed by the scope path, so the SCM selection
    // must not re-target it (which would also write the shared setRepo state).
    if (scope !== undefined) return
    if (!scmSelectedRepo) return
    if (repos.length === 0) return
    if (!repos.find((r) => r.root === scmSelectedRepo)) return
    const effectiveRepo = selectedRepo ?? repos[0]?.root ?? null
    if (scmSelectedRepo === effectiveRepo) {
      if (selectedRepo === null) setSelectedRepo(scmSelectedRepo)
      return
    }
    onSelectRepo(scmSelectedRepo)
  }, [scmSelectedRepo, repos, selectedRepo, onSelectRepo, scope])

  const adjustColumn = useCallback(
    (col: 'author' | 'date', deltaX: number) => {
      setColumnWidths((prev) => {
        const next = { ...prev, [col]: Math.max(MIN_COL_WIDTH, prev[col] - deltaX) }
        view.columnWidths = next
        return next
      })
    },
    [view],
  )

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
    if (scrollRef.current) scrollRef.current.scrollTop = view.scrollTop
  }, [view])

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

  // Single-file scope: open the diff of the scoped file at the given change.
  // Falls back to selecting the row (whole-CL file list in Commit Changes) when
  // the change's file list has no entry for the scoped path — possible only when
  // the client view no longer maps it.
  const openScopedFileDiff = useCallback(
    async (id: string) => {
      const only = scope?.paths.length === 1 ? scope.paths[0] : undefined
      if (only === undefined) return
      const details = await commands.executeCommand<P4GraphChangeDetailsDto | null>(
        PerforceGraphCommands.getChangeDetails,
        id,
        { ...(clientRoot !== undefined ? { clientRoot } : {}) },
      )
      const scopeKey = scmProviderPathKey(only.path)
      const file = details?.files.find(
        (f) => f.localPath !== null && scmProviderPathKey(f.localPath) === scopeKey,
      )
      if (!file) {
        logger?.warn(`open changes: change ${id} has no entry for ${only.path}, showing the CL`)
        applySelection([id])
        return
      }
      await commands.executeCommand(PerforceGraphCommands.openFileDiff, {
        depotFile: file.depotFile,
        status: file.status,
        rev: file.rev,
        ...(file.localPath !== null ? { localPath: file.localPath } : {}),
        ...(clientRoot !== undefined ? { clientRoot } : {}),
      })
    },
    [applySelection, commands, logger, scope, clientRoot],
  )

  const openChangeMenu = useCallback(
    (change: P4GraphChangeDto, e: MouseEvent) => {
      e.preventDefault()
      const id = change.id
      if (id === PENDING_ID) return
      // Both graph kinds get the same destructive entry; only the payload's
      // scope differs. Built in one place so the label/icon/`danger` and — more
      // to the point — the absent `isLatest`/`confirmed` cannot drift apart
      // between the two branches. Those two fields only waive the time-travel
      // prompt, and the extension's force prompt has no waiver (see
      // `graphSyncConfirmKind`): sending `isLatest` here would be a silent path
      // to overwriting local work.
      const forceGet = (payload: Omit<P4GraphSyncRequest, 'force'>): GitGraphMenuItem => ({
        kind: 'item',
        id: 'forceGet',
        icon: 'cloud-download',
        danger: true,
        label: localize('perforceGraph.forceGet', 'Force Get (Overwrite Local Files)'),
        run: () =>
          getThenRevalidate(PerforceGraphCommands.syncToChange, {
            ...payload,
            force: true,
          }),
      })
      const items: GitGraphMenuItem[] = [
        {
          kind: 'item',
          id: 'copyId',
          icon: 'copy',
          label: localize('perforceGraph.copyId', 'Copy changelist number'),
          run: () => void navigator.clipboard?.writeText(id),
        },
        {
          kind: 'item',
          id: 'copyMessage',
          icon: 'copy',
          label: localize('gitGraph.copyMessage', 'Copy commit message'),
          run: () => void navigator.clipboard?.writeText(change.body || change.message),
        },
        { kind: 'sep' },
        {
          kind: 'item',
          id: 'sendToAgentChat',
          icon: 'sparkle',
          label: localize('gitGraph.sendToAgentChat', 'Send to Agent Chat'),
          run: () =>
            void commands.executeCommand(SendCommitToAgentChatAction.ID, {
              hash: id,
              message: change.message,
            }),
        },
      ]
      // Scoped tab (one or many paths): every listed change touched at least one
      // scoped path (that is what `p4 changes <filespec…>` returns), so the Get
      // pair is always offered and file entries are resolved on click. Resolving
      // up front would block the menu on `describe -s`, which is GB-scale on a
      // giant branch CL.
      if (scope !== undefined) {
        const paths = scope.paths
        const onlyFile =
          paths.length === 1 && paths[0]!.isDirectory === false ? paths[0]! : undefined
        items.push({ kind: 'sep' })
        // Open Changes is single-file only: with several paths there is no one
        // diff to open, and the per-file rows in Commit Changes each carry their own.
        if (onlyFile !== undefined) {
          items.push({
            kind: 'item',
            id: 'openChanges',
            icon: 'compare-changes',
            label: localize('perforceGraph.openChanges', 'Open Changes'),
            run: () => void openScopedFileDiff(id),
          })
        }
        items.push(
          {
            kind: 'item',
            id: 'getThisRevision',
            icon: 'cloud-download',
            label: localize('perforceGraph.getThisRevision', 'Get This Revision'),
            run: () =>
              getThenRevalidate(PerforceGraphCommands.syncToChange, {
                change: id,
                scopePaths: paths.map((p) => ({ path: p.path, isDirectory: p.isDirectory })),
                isLatest: id === result?.head,
              }),
          },
          {
            kind: 'item',
            id: 'getLatestRevision',
            icon: 'cloud-download',
            label: localize('perforceGraph.getLatestRevision', 'Get Latest Revision'),
            run: () => {
              // Reuse the extension's multi-select sync path: `(primary, selection)`,
              // with bare `resourceUri` strings (`resourcePath` reads those directly).
              const selectionArgs = paths.map((p) => ({
                resourceUri: p.path,
                isDirectory: p.isDirectory,
              }))
              getThenRevalidate('perforce.syncLatest', selectionArgs[0], selectionArgs)
            },
          },
          { kind: 'sep' },
          forceGet({
            change: id,
            scopePaths: paths.map((p) => ({ path: p.path, isDirectory: p.isDirectory })),
          }),
        )
      }
      // Whole-repo graph: sync the whole client (honouring the scope toggle),
      // or pick top-level directories via the multi-directory dialog.
      if (scope === undefined) {
        items.push(
          { kind: 'sep' },
          {
            kind: 'item',
            id: 'getThisRevision',
            icon: 'cloud-download',
            label: localize('perforceGraph.getThisRevision', 'Get This Revision'),
            run: () =>
              getThenRevalidate(PerforceGraphCommands.syncToChange, {
                change: id,
                wholeRepo,
                isLatest: id === result?.head,
              }),
          },
          {
            kind: 'item',
            id: 'getRevision',
            icon: 'cloud-download',
            label: localize('perforceGraph.getRevision', 'Get Revision…'),
            run: () =>
              void (async () => {
                let scopes: P4GraphSyncScopeDto[] = []
                try {
                  scopes =
                    (await commands.executeCommand<P4GraphSyncScopeDto[]>(
                      PerforceGraphCommands.getSyncScopes,
                    )) ?? []
                } catch {
                  // Empty list: the dialog opens and explains itself.
                }
                setSyncDialog({
                  change: id,
                  isLatest: id === result?.head,
                  candidates: scopes,
                })
              })(),
          },
          { kind: 'sep' },
          forceGet({ change: id, wholeRepo }),
        )
      }
      // The sync point belongs to the whole listing rather than to the clicked
      // row, but this is the graph's only context menu — so the two things the
      // toolbar line offers live here as well, for the user who is reading rows
      // rather than chrome. Re-asking the server is the only way to see a sync
      // done outside the editor; jumping is the only way to see WHICH row the
      // badge is on once it has been filtered or paged away.
      items.push(
        { kind: 'sep' },
        {
          kind: 'item',
          id: 'querySyncPoint',
          icon: 'sync',
          label: localize('perforceGraph.syncPoint.query', 'Query Sync Point'),
          run: () => refreshSyncPoint('query'),
        },
        ...(syncPoint
          ? [
              {
                kind: 'item' as const,
                id: 'revealSyncPoint',
                icon: 'go-to-definition',
                label: localize('perforceGraph.syncPoint.reveal', 'Go to Sync Point'),
                // Same entry point as the toolbar's `#CL`: the point itself when
                // this history has it, the newest change it covers otherwise.
                run: () => revealCommit(syncPoint.id, { onMiss: 'below' }),
              },
            ]
          : []),
      )
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items,
        keyboard: isKeyboardContextMenu(e),
        contextTag: 'changelist',
      })
    },
    [
      commands,
      openScopedFileDiff,
      scope,
      wholeRepo,
      result,
      setSyncDialog,
      getThenRevalidate,
      refreshSyncPoint,
      syncPoint,
      revealCommit,
    ],
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

  /** The row the badge sits on, which for a sync point this history does not
   *  contain is the newest change the sync covers (see `syncPointRowOf`). */
  const syncPointRow = useMemo(
    () =>
      syncPoint === null || result === null ? null : syncPointRowOf(result.changes, syncPoint.id),
    [result, syncPoint],
  )

  const haveTooltip = useMemo(() => {
    if (syncPointRow === null || syncPoint === null) return ''
    return syncPointRow.exact
      ? localize(
          'perforceGraph.haveBadge.tooltip',
          'The newest changelist this workspace has been synced to; changes newer than this row are not synced yet (the toolbar’s “Synced to” has the provenance and its age).',
        )
      : localize(
          'perforceGraph.haveBadge.coveredTooltip',
          'Sync point #{point} changed nothing under this scope, so it has no row here. This is the newest change that the sync does cover; changes newer than this row are not synced yet.',
          { point: syncPoint.id },
        )
  }, [syncPointRow, syncPoint])

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
  // Filtering drops parents outside the result set, so the layout draws dangling
  // lines to nothing — carry no topology, just noise. Hide the lanes entirely.
  const isCompact = deferredQuery.trim() !== ''
  const effectiveGraphWidth = isCompact ? GRID.offsetX * 2 : graphWidth
  const selected = useMemo(() => new Set(selection), [selection])

  // ContextMenu key / Shift+F10 (or Ctrl+Enter) on the selected row: a changelist
  // row has exactly one menu target (the change itself), so the menu opens
  // directly, anchored at the row.
  const openRowMenu = useCallback(
    (id: string) => {
      const change = filteredChanges.find((c) => c.id === id)
      if (!change || id === PENDING_ID) return
      const rowEl = scrollRef.current
        ?.querySelectorAll('[data-id]')
        .values()
        .find((el) => el.getAttribute('data-id') === id)
      const rect = rowEl?.getBoundingClientRect()
      // A marked (but never dispatched) event: `openChangeMenu` reads coordinates
      // off it and asks `isKeyboardContextMenu` whether to open with the first
      // row highlighted, exactly as it does for a real right-click.
      openChangeMenu(
        change,
        createKeyboardContextMenuEvent(
          (rect?.left ?? 0) + 16,
          rect?.bottom ?? 0,
        ) as unknown as MouseEvent,
      )
    },
    [filteredChanges, openChangeMenu],
  )

  const rowKeys = useMemo(() => filteredChanges.map((c) => c.id), [filteredChanges])
  const selectFromKeyboard = useCallback((id: string) => applySelection([id]), [applySelection])
  const openCommitChanges = useCallback(
    () => void commands.executeCommand(FocusCommitChangesAction.ID),
    [commands],
  )

  usePersistedGraphSelection({
    storageKey: 'perforceGraph.lastSelectedChange',
    selection,
    effectiveRepo: selectedRepo ?? repos[0]?.root ?? null,
    result,
    pendingReveal: view.pendingReveal,
    excludedIds: PERSISTENCE_EXCLUDED_IDS,
    defaultRowId: rowKeys.find((k) => k !== PENDING_ID) ?? null,
    selectDefault: selectFromKeyboard,
    // A scoped tab is a one-shot view: persisting would pollute workspace
    // storage and grow the per-repo key map without bound for every path viewed.
    persist: scope === undefined,
  })
  const onRowsKeyDown = useGraphKeyboardNav({
    rows: rowKeys,
    selectionRef,
    select: selectFromKeyboard,
    openMenu: openRowMenu,
    openCommitChanges,
    scrollRef,
    rowAttribute: 'data-id',
    rowHeight: ROW_HEIGHT,
  })

  // Go to Symbol / Outline bridge: publish the loaded changes (the unfiltered
  // display list, so a search filter can't shrink the symbol list) and select /
  // scroll rows on demand. selectCommit deliberately reuses applySelection so
  // accepting a symbol carries full row-click semantics — pushing COMMIT
  // CHANGES and expanding the SCM sidebar.
  const outlineCommits = useMemo(
    () => observableValue<readonly GraphOutlineCommit[]>('perforceGraph.outlineCommits', []),
    [],
  )
  useEffect(() => {
    outlineCommits.set(
      displayChanges.map((c) =>
        c.id === PENDING_ID
          ? { hash: c.id, label: c.message, detail: '', pending: true }
          : {
              hash: c.id,
              label: c.message,
              detail: `${shortId(c.id)} · ${c.author} · ${formatDate(c.date)}`,
            },
      ),
      undefined,
    )
  }, [outlineCommits, displayChanges])

  const onDidChangeOutlineSelection = useMemo(() => new Emitter<void>(), [])
  useEffect(() => {
    onDidChangeOutlineSelection.fire()
  }, [onDidChangeOutlineSelection, selection])

  useEffect(() => {
    const controller: IGraphOutlineController = {
      commits: outlineCommits,
      selectCommit: (id) => {
        // A search filter would hide the target row.
        setSearchQuery('')
        applySelection([id])
        pendingScrollRef.current = id
        scrollPendingReveal()
        scrollRef.current?.focus()
      },
      scrollToCommit: (id) => {
        pendingScrollRef.current = id
        scrollPendingReveal()
      },
      getSelectedHash: () => {
        const current = selectionRef.current
        return current.length === 1 ? current[0] : undefined
      },
      onDidChangeSelection: onDidChangeOutlineSelection.event,
    }
    GraphOutlineRegistry.register(PERFORCE_GRAPH_OUTLINE_LANGUAGE_ID, controller, inputId)
    return () => {
      GraphOutlineRegistry.unregister(PERFORCE_GRAPH_OUTLINE_LANGUAGE_ID, controller)
    }
  }, [outlineCommits, onDidChangeOutlineSelection, applySelection, scrollPendingReveal, inputId])

  return (
    <div className={styles['gitGraph']} data-testid="perforceGraph-editor">
      <div className={styles['toolbar']}>
        <span
          className={styles['title']}
          // Every scoped path, one per line — the `+N` label alone doesn't say which.
          data-tooltip={scope !== undefined ? scope.paths.map((p) => p.path).join('\n') : undefined}
        >
          {scope !== undefined
            ? localize('perforceGraph.scopedTitle', 'History: {label}', { label: scope.label })
            : localize('perforceGraph.title', 'Perforce Graph')}
        </span>
        {result && result.error === undefined && (
          <span className={styles['count']}>
            {localize('perforceGraph.changeCount', '{count} changes{more}', {
              count: result.changes.length,
              more: result.moreAvailable ? '+' : '',
            })}
            {result.headClient
              ? localize('perforceGraph.onClient', ' · {client}', { client: result.headClient })
              : ''}
            {/* The badge only exists for a loaded row; this line is the one signal
                that survives the sync point being paged out, filtered away or
                scrolled off — and it is the only handle on the query button and
                on jumping to the row. */}
            {localize('perforceGraph.syncedTo', ' · Synced to ')}
            {syncPoint ? (
              <button
                type="button"
                className={styles['syncPointLink']}
                data-testid="perforceGraph-syncPoint"
                data-tooltip={syncPointTooltip(syncPoint)}
                onClick={() => revealCommit(syncPoint.id, { onMiss: 'below' })}
              >
                #{syncPoint.id}
              </button>
            ) : (
              // Nothing recorded and nothing asked: say so rather than showing a
              // stale id. The graph's own scope is too wide to probe on its own
              // (tens of seconds), so the query is the user's call.
              <button
                type="button"
                className={styles['syncPointLink']}
                data-testid="perforceGraph-syncPoint"
                data-tooltip={
                  queriedEmpty
                    ? // An ANSWER, not a gap: the server just said this scope's
                      // files are all outside its have list. Saying "not known"
                      // here would send the user back to the same tens-of-seconds
                      // query they just ran.
                      localize(
                        'perforceGraph.syncPoint.answeredEmpty',
                        'Perforce answered: nothing in this scope is synced yet. Click to ask again.',
                      )
                    : localize(
                        'perforceGraph.syncPoint.queryTooltip',
                        'Where this workspace has been pulled to is not known. Click to ask Perforce — on a wide scope this can take a while.',
                      )
                }
                onClick={() => refreshSyncPoint('query')}
              >
                {localize('perforceGraph.syncedToUnknown', '#? (click to query)')}
              </button>
            )}
            {/* The query button sits with the answer it refreshes, not in the
                row of view controls: re-asking is about THIS number. It is also
                the only handle on a `p4 sync` done outside the editor. Its glyph
                is the same `sync` icon as the menu item's, so the two read as one
                action rather than a question mark about one. */}
            <button
              type="button"
              className={styles['syncQueryBtn']}
              onClick={() => refreshSyncPoint('query')}
              data-tooltip={
                syncQuery && !syncQuery.done
                  ? localize('perforceGraph.syncPoint.querying', 'Querying the sync point…')
                  : localize(
                      'perforceGraph.syncPoint.queryButton',
                      'Ask Perforce where this workspace has been pulled to. Use it when the sync point is not known, or to re-check one recorded a while ago — on a wide scope it can take a while.',
                    )
              }
              aria-label={
                syncQuery && !syncQuery.done
                  ? localize('perforceGraph.syncPoint.querying', 'Querying the sync point…')
                  : localize('perforceGraph.syncPoint.query', 'Query Sync Point')
              }
              data-testid="perforceGraph-querySyncPoint"
              {...(syncQuery && !syncQuery.done ? { 'data-querying': 'true' } : {})}
            >
              {syncQuery && !syncQuery.done ? <Spinner size={12} /> : <RefreshCw size={13} />}
            </button>
            {syncQuery && (
              // Elapsed clock, kept for a beat after the answer lands: on a fast
              // scope this is the only visible proof the click did anything.
              <span
                className={styles['syncQueryElapsed']}
                data-testid="perforceGraph-queryElapsed"
                {...(syncQuery.done ? { 'data-done': 'true' } : {})}
                {...(syncQuery.done && syncQuery.failed ? { 'data-failed': 'true' } : {})}
                {...(syncQuery.done && syncQuery.failed
                  ? {
                      'data-tooltip': localize(
                        'perforceGraph.syncPoint.failed',
                        'The query did not answer (Perforce failed or timed out), so the sync point is unchanged. The Perforce output channel has the details.',
                      ),
                    }
                  : {})}
              >
                {formatElapsed(syncQuery.ms)}
              </span>
            )}
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
        {scope === undefined && repos.length > 1 && (
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
        {scope === undefined && (
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
        )}
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
            view.scrollTop = e.currentTarget.scrollTop
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
              {localize('perforceGraph.header.change', 'Change')}
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
                    stroke={p.isCommitted ? PALETTE[0] : '#808080'}
                    strokeWidth={2}
                    {...(p.isCommitted ? {} : { strokeDasharray: '2' })}
                  />
                ))}
              {layout.vertices.map((v) => {
                const cx = isCompact ? GRID.offsetX : v.cx
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
                return v.isCurrent ? (
                  <circle
                    key={v.id}
                    cx={cx}
                    cy={v.cy}
                    r={4}
                    className={styles['nodeCurrent']}
                    stroke={PALETTE[0]}
                    strokeWidth={2}
                  />
                ) : (
                  <circle key={v.id} cx={cx} cy={v.cy} r={4} fill={PALETTE[0]} />
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
              {filteredChanges.map((c) => (
                <ChangeRow
                  key={c.id}
                  change={c}
                  selected={selected.has(c.id)}
                  // The synthetic pending row's id is `'*'`, which can never equal
                  // a numeric changelist id — no special case needed.
                  isHave={c.id === syncPointRow?.id}
                  haveTooltip={haveTooltip}
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
            // The menu navigates by virtual focus, so the graph never lost DOM
            // focus — but a mouse right-click may have landed outside it, and
            // arrow-key navigation only works while the container holds focus.
            scrollRef.current?.focus()
          }}
        />
      )}
      {syncDialog && (
        <PerforceGraphSyncDialog
          state={syncDialog}
          onConfirm={(paths) => {
            const d = syncDialog
            setSyncDialog(null)
            getThenRevalidate(PerforceGraphCommands.syncToChange, {
              change: d.change,
              isLatest: d.isLatest,
              confirmed: true,
              scopePaths: paths.map((path) => ({ path, isDirectory: true })),
            })
          }}
          onCancel={() => setSyncDialog(null)}
        />
      )}
    </div>
  )
}
