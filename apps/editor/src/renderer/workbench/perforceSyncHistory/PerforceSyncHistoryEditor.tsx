/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PerforceSyncHistoryEditor — the local record of every get this editor ran:
 *  a list of runs (newest first) with the selected run's detail beside it.
 *
 *  Data comes from the `perforce` extension over command calls, never from p4:
 *  `perforce-sync-history.getRuns` / `.getRun` answer from a JSON file under the
 *  extension's global storage (see
 *  packages/extensions-common/src/contracts/perforceSyncHistory.ts). The page
 *  therefore costs nothing to open, which is why it loads on mount without a
 *  "query" step — and why it must still say "unavailable" for the two facts a
 *  run is allowed not to have (a machine with no I/O sampler, a run that never
 *  spawned p4 at all).
 *
 *  The list keeps `useFlatListNavigation`'s house keyboard model — container
 *  focus, rows as data, selection follows focus — same as AI Debug, because
 *  "browse the recorded runs" is the same interaction.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ICommandService,
  IStorageService,
  StorageScope,
  localize,
  type IEditorInput,
} from '@universe-editor/platform'
import {
  PerforceSyncHistoryCommands,
  type P4SyncHistoryLoadResult,
  type P4SyncRunDetailDto,
  type P4SyncRunDto,
} from '@universe-editor/extensions-common'
import {
  Button,
  Sash,
  useFlatListNavigation,
  useScrollRestore,
  type IFlatListRowProps,
} from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { relativeTime } from '../../relativeTime.js'
import {
  perforceSyncHistoryViewState,
  SYNC_HISTORY_PAGE_SIZE,
} from '../../services/perforceSyncHistory/syncHistoryViewState.js'
import { ExportPerforceSyncHistoryAction } from '../../actions/perforceSyncHistoryActions.js'
import {
  countsLine,
  engineLabel,
  filesLabel,
  formatBytes,
  formatDiskWrites,
  formatDuration,
  formatTarget,
  outcomeLabel,
  scopeLines,
  triggerLabel,
} from './syncHistoryFormat.js'
import styles from './PerforceSyncHistoryEditor.module.css'

const SCROLL_KEY = 'perforce-sync-history'
/** The dragged list-pane width, per install: the page itself is
 *  workspace-agnostic (the records live in the extension's global storage), so
 *  the width follows the page, not the folder. */
const LIST_WIDTH_KEY = 'perforceSyncHistory.listWidth'
const MIN_LIST_PANE_WIDTH = 200
/** Past this share of the editor group the rows ellipsize rather than eat the
 *  detail pane; mirrors `.listPane`'s CSS `max-width`. */
const MAX_LIST_PANE_FRACTION = 0.6
/** Fallback for a container with no layout (tests): `getBoundingClientRect`
 *  reports 0, and a drag has to start from something. */
const DEFAULT_LIST_PANE_WIDTH = 360

export function PerforceSyncHistoryEditor(_props: { input: IEditorInput }) {
  const commands = useService(ICommandService)
  const storage = useService(IStorageService)
  const state = perforceSyncHistoryViewState

  const [runs, setRuns] = useState<readonly P4SyncRunDto[]>(state.runs)
  const [total, setTotal] = useState(state.total)
  const [hasMore, setHasMore] = useState(state.hasMore)
  const [loaded, setLoaded] = useState(state.loaded)
  const [selectedId, setSelectedId] = useState<string | null>(state.selectedId)
  const [unavailable, setUnavailable] = useState(false)
  const [listWidth, setListWidth] = useState<number | null>(state.listWidth)

  const listRef = useRef<HTMLUListElement | null>(null)
  const listPaneRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dragBaseRef = useRef<number | null>(null)
  const dragMovedRef = useRef(false)
  const getContainer = useCallback(() => listRef.current, [])
  useScrollRestore(SCROLL_KEY, getContainer)

  const load = useCallback(
    async (limit: number): Promise<void> => {
      try {
        const page = await commands.executeCommand<P4SyncHistoryLoadResult>(
          PerforceSyncHistoryCommands.getRuns,
          { max: limit },
        )
        // The command answers `undefined` when the extension is not there at
        // all; a shape check keeps a half-built answer from rendering as a list
        // of nothing.
        if (page === undefined || !Array.isArray(page.runs)) {
          setUnavailable(true)
          return
        }
        setUnavailable(false)
        setRuns(page.runs)
        setTotal(page.total)
        setHasMore(page.hasMore)
        setLoaded(true)
        state.runs = [...page.runs]
        state.total = page.total
        state.hasMore = page.hasMore
        state.limit = limit
        state.loaded = true
        // The next selection is decided from the MODULE state, not from React's:
        // a first load can settle after this component unmounted (the tab was
        // deactivated), and reading React state there would write back the
        // initial `null` — leaving `loaded` true with no selection, so the page
        // would come back showing no highlight while claiming to be loaded.
        const keep = state.selectedId
        const next = keep !== null && page.runs.some((r) => r.id === keep) ? keep : undefined
        const selected = next ?? page.runs[0]?.id ?? null
        state.selectedId = selected
        setSelectedId(selected)
      } catch {
        // A rejected command means no perforce extension in this install (or one
        // too old to know this id). The page states that instead of showing an
        // empty history, which would read as "you never synced anything".
        setUnavailable(true)
      }
    },
    [commands, state],
  )

  const refresh = useCallback((): void => {
    void load(state.limit)
  }, [load, state])

  useEffect(() => {
    // The module-level view state survives this component's unmount, so a
    // return to the tab shows the page it left — while the store still knows
    // nothing about it.
    if (!state.loaded) void load(state.limit)
  }, [load, state])

  useEffect(() => {
    state.refresh = refresh
    // Focus routing only exists while the list does. In the unavailable state
    // there is no container to focus, and a `focusRows` that returns true while
    // focusing nothing would swallow the editor input's own fallback.
    if (!unavailable) state.focusRows = () => listRef.current?.focus()
    return () => {
      state.focusRows = null
      state.refresh = null
    }
  }, [state, refresh, unavailable])

  useEffect(() => {
    state.selectedId = selectedId
  }, [state, selectedId])

  useEffect(() => {
    // The module state already holds this session's width; storage is only read
    // on the first mount after a restart.
    if (state.listWidth !== null) return
    let alive = true
    void storage
      .get<number>(LIST_WIDTH_KEY, StorageScope.GLOBAL)
      .then((stored) => {
        if (!alive || typeof stored !== 'number' || !Number.isFinite(stored)) return
        const width = Math.max(MIN_LIST_PANE_WIDTH, Math.round(stored))
        state.listWidth = width
        setListWidth(width)
      })
      .catch(() => {
        // Unreadable storage just means the pane keeps sizing to its content.
      })
    return () => {
      alive = false
    }
  }, [storage, state])

  const measuredPaneWidth = useCallback((): number => {
    const width = listPaneRef.current?.getBoundingClientRect().width ?? 0
    return width > 0 ? width : DEFAULT_LIST_PANE_WIDTH
  }, [])

  const maxPaneWidth = useCallback((): number => {
    // `|| window.innerWidth`: a container with no layout yet (or a hidden group)
    // reports 0, and 0 must not collapse the ceiling to the minimum.
    const available = bodyRef.current?.clientWidth || window.innerWidth
    return Math.max(MIN_LIST_PANE_WIDTH, Math.round(available * MAX_LIST_PANE_FRACTION))
  }, [])

  const onSashStart = useCallback((): void => {
    dragMovedRef.current = false
    // From what is on screen, not from state: a stored width the CSS has since
    // clamped (narrower window) must not make the first drag jump.
    dragBaseRef.current = measuredPaneWidth()
  }, [measuredPaneWidth])

  const onSashResize = useCallback(
    (delta: number): void => {
      const next = Math.min(
        Math.max((dragBaseRef.current ?? measuredPaneWidth()) + delta, MIN_LIST_PANE_WIDTH),
        maxPaneWidth(),
      )
      dragBaseRef.current = next
      dragMovedRef.current = true
      setListWidth(next)
    },
    [measuredPaneWidth, maxPaneWidth],
  )

  const onSashEnd = useCallback((): void => {
    const width = dragBaseRef.current
    dragBaseRef.current = null
    // A plain click is not a resize: it must not freeze the pane's
    // content-sized width into a pixel value.
    if (!dragMovedRef.current || width === null) return
    dragMovedRef.current = false
    state.listWidth = width
    void storage.set(LIST_WIDTH_KEY, width, StorageScope.GLOBAL)
  }, [storage, state])

  const focusedIndex = useMemo(
    () => (selectedId === null ? -1 : runs.findIndex((r) => r.id === selectedId)),
    [runs, selectedId],
  )

  const nav = useFlatListNavigation({
    count: runs.length,
    focusedIndex,
    onFocusChange: useCallback((index: number) => setSelectedId(runs[index]?.id ?? null), [runs]),
    getItemKey: useCallback((index: number) => runs[index]?.id ?? '', [runs]),
    getContainer,
    ariaLabel: localize('perforceSyncHistory.list', 'Recorded sync runs'),
  })

  if (unavailable) {
    // Not a dead end: the extension may come up later in this window (a perforce
    // workspace opened after this tab was), and re-asking is the only way to
    // find out without closing and reopening the tab.
    return (
      <div className={styles['root']} data-testid="perforce-sync-history">
        <div className={styles['toolbar']}>
          <Button
            variant="secondary"
            size="sm"
            data-testid="perforce-sync-history-refresh"
            onClick={refresh}
          >
            {localize('perforceSyncHistory.refresh', 'Refresh')}
          </Button>
        </div>
        <div className={styles['empty']} data-testid="perforce-sync-history-unavailable">
          {localize(
            'perforceSyncHistory.unavailable',
            'The Perforce extension is not available, so the sync history cannot be read.',
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles['root']} data-testid="perforce-sync-history">
      <div className={styles['toolbar']}>
        <span className={styles['count']} data-testid="perforce-sync-history-count">
          {localize('perforceSyncHistory.count', '{0} run(s)', { 0: String(total) })}
        </span>
        <Button
          variant="secondary"
          size="sm"
          data-testid="perforce-sync-history-refresh"
          onClick={refresh}
        >
          {localize('perforceSyncHistory.refresh', 'Refresh')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          data-testid="perforce-sync-history-export"
          onClick={() => void commands.executeCommand(ExportPerforceSyncHistoryAction.ID)}
        >
          {localize('perforceSyncHistory.exportCsv', 'Export CSV…')}
        </Button>
      </div>
      <div className={styles['body']} ref={bodyRef}>
        <div
          className={styles['listPane']}
          ref={listPaneRef}
          data-testid="perforce-sync-history-list-pane"
          {...(listWidth !== null ? { style: { width: `${listWidth}px` } } : {})}
        >
          <ul {...nav.containerProps} className={styles['list']} ref={listRef}>
            {runs.length === 0 && (
              <li
                className={styles['empty']}
                data-testid="perforce-sync-history-empty"
                role="presentation"
              >
                {loaded
                  ? localize(
                      'perforceSyncHistory.none',
                      'No sync runs recorded yet. Get the latest revision from the Explorer, the status bar chip or the Perforce Graph and it will show up here.',
                    )
                  : localize('perforceSyncHistory.loading', 'Loading…')}
              </li>
            )}
            {runs.map((run, index) => (
              <RunRow
                key={run.id}
                run={run}
                selected={run.id === selectedId}
                rowProps={nav.getRowProps(index)}
              />
            ))}
          </ul>
          {hasMore && (
            <button
              type="button"
              className={styles['loadMore']}
              data-testid="perforce-sync-history-load-more"
              onClick={() => void load(state.limit + SYNC_HISTORY_PAGE_SIZE)}
            >
              {localize('perforceSyncHistory.loadMore', 'Load more')}
            </button>
          )}
        </div>
        <Sash
          orientation="vertical"
          onStart={onSashStart}
          onResize={onSashResize}
          onEnd={onSashEnd}
        />
        <div className={styles['detail']}>
          {selectedId === null ? (
            <div className={styles['hint']} data-testid="perforce-sync-history-no-selection">
              {localize('perforceSyncHistory.select', 'Select a run to see what it did.')}
            </div>
          ) : (
            // Keyed: a new row must not render under the previous row's numbers.
            // The detail arrives from an async call, and without a remount the
            // pane keeps showing the old run (its counts, its duration) next to
            // the new row's highlight until the answer lands — or forever, if the
            // user moved on before it did.
            <RunDetail key={selectedId} id={selectedId} />
          )}
        </div>
      </div>
    </div>
  )
}

function RunRow({
  run,
  selected,
  rowProps,
}: {
  run: P4SyncRunDto
  selected: boolean
  rowProps: IFlatListRowProps
}) {
  return (
    <li
      {...rowProps}
      className={styles['row']}
      data-outcome={run.outcome}
      data-selected={selected ? 'true' : undefined}
      data-testid="perforce-sync-history-row"
      data-tooltip={`${formatTarget(run.spec)} · ${triggerLabel(run.trigger)}`}
    >
      <span className={styles['rowTime']} data-testid="perforce-sync-history-row-time">
        {relativeTime(run.at)}
      </span>
      <span className={styles['rowOutcome']} data-outcome={run.outcome}>
        {outcomeLabel(run.outcome)}
      </span>
      <span className={styles['rowTarget']}>{formatTarget(run.spec)}</span>
      <span className={styles['rowMeta']}>{countsLine(run) ?? ''}</span>
      <span className={styles['rowDuration']}>{formatDuration(run.durationMs)}</span>
    </li>
  )
}

/** Why the pane has nothing to draw. Three distinct answers, because they have
 *  three distinct causes and only one of them is about this record. */
type DetailState =
  | { readonly kind: 'loading' }
  /** The `perforce` extension is not there to answer (command unregistered). */
  | { readonly kind: 'unavailable' }
  /** The extension answered, and this history has no such record. */
  | { readonly kind: 'missing' }
  | { readonly kind: 'ready'; readonly detail: P4SyncRunDetailDto }

function RunDetail({ id }: { id: string }) {
  const commands = useService(ICommandService)
  const [state, setState] = useState<DetailState>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    void Promise.resolve(
      commands.executeCommand<P4SyncRunDetailDto | null | undefined>(
        PerforceSyncHistoryCommands.getRun,
        id,
      ),
    )
      .then((d) => {
        if (!active) return
        if (d === undefined) {
          // The command is not registered: no perforce extension in this install
          // (or one that has not activated). NOT the same as a rotated-out
          // record — see the contract — so it must not be reported as one.
          setState({ kind: 'unavailable' })
          return
        }
        if (d === null) {
          // The extension answered and does not have this id: rotation can drop
          // a record between the list load and this click. The pane says so
          // rather than rendering a half-empty detail.
          setState({ kind: 'missing' })
          return
        }
        setState({ kind: 'ready', detail: d })
      })
      .catch(() => {
        // A rejection is the transport failing, which the user can do nothing
        // about either — the same sentence as an absent extension fits.
        if (active) setState({ kind: 'unavailable' })
      })
    return () => {
      active = false
    }
  }, [commands, id])

  if (state.kind === 'unavailable') {
    return (
      <div className={styles['hint']} data-testid="perforce-sync-history-detail-unavailable">
        {localize(
          'perforceSyncHistory.unavailable',
          'The Perforce extension is not available, so the sync history cannot be read.',
        )}
      </div>
    )
  }
  if (state.kind === 'missing') {
    return (
      <div className={styles['hint']} data-testid="perforce-sync-history-detail-missing">
        {localize(
          'perforceSyncHistory.detailMissing',
          'This run is no longer in the history — older runs are dropped once the history fills up.',
        )}
      </div>
    )
  }
  if (state.kind === 'loading') {
    return (
      <div className={styles['hint']} data-testid="perforce-sync-history-detail-loading">
        {localize('perforceSyncHistory.loading', 'Loading…')}
      </div>
    )
  }

  const detail = state.detail
  const scope = scopeLines(detail)
  const startedAt = new Date(detail.startedAt).toLocaleString()

  return (
    <div data-testid="perforce-sync-history-detail">
      <Section title={localize('perforceSyncHistory.section.overview', 'Overview')}>
        <dl className={styles['kv']}>
          <dt>{localize('perforceSyncHistory.field.outcome', 'Result')}</dt>
          <dd data-testid="perforce-sync-history-detail-outcome" data-outcome={detail.outcome}>
            {outcomeLabel(detail.outcome)}
          </dd>
          <dt>{localize('perforceSyncHistory.field.time', 'Started')}</dt>
          <dd>{startedAt}</dd>
          <dt>{localize('perforceSyncHistory.field.duration', 'Duration')}</dt>
          <dd data-testid="perforce-sync-history-detail-duration">
            {formatDuration(detail.durationMs)}
          </dd>
          {detail.error !== undefined ? (
            <>
              <dt>{localize('perforceSyncHistory.field.error', 'Error')}</dt>
              <dd className={styles['error']}>{detail.error.message}</dd>
            </>
          ) : detail.outcome === 'failed' || detail.outcome === 'unrecognized' ? (
            <>
              <dt>{localize('perforceSyncHistory.field.error', 'Error')}</dt>
              <dd className={styles['muted']}>
                {localize(
                  'perforceSyncHistory.errorInOutput',
                  'See the Perforce output channel for what p4 said.',
                )}
              </dd>
            </>
          ) : null}
        </dl>
      </Section>

      <Section title={localize('perforceSyncHistory.section.transfer', 'Transfer')}>
        <dl className={styles['kv']}>
          <dt>{localize('perforceSyncHistory.field.files', 'Files')}</dt>
          <dd data-testid="perforce-sync-history-detail-files">{filesLabel(detail)}</dd>
          <dt>{localize('perforceSyncHistory.field.read', 'Read')}</dt>
          <dd data-testid="perforce-sync-history-detail-read">
            {detail.io !== undefined
              ? formatBytes(detail.io.readBytes)
              : localize(
                  'perforceSyncHistory.ioUnavailable',
                  'unavailable (no sampler on this platform)',
                )}
          </dd>
          <dt>{localize('perforceSyncHistory.field.write', 'Written')}</dt>
          <dd data-testid="perforce-sync-history-detail-write">
            {detail.io !== undefined
              ? formatBytes(detail.io.writeBytes)
              : localize(
                  'perforceSyncHistory.ioUnavailable',
                  'unavailable (no sampler on this platform)',
                )}
          </dd>
          <dt>{localize('perforceSyncHistory.field.diskWrites', 'On disk')}</dt>
          <dd data-testid="perforce-sync-history-detail-diskwrites">
            {detail.diskWrites !== undefined
              ? formatDiskWrites(detail.diskWrites)
              : localize('perforceSyncHistory.notRun', 'this get never ran')}
          </dd>
        </dl>
        <div className={styles['note']}>
          {localize(
            'perforceSyncHistory.ioNote',
            'Read/written are the p4 process’s own I/O counters, not a network/disk split. On-disk counts come from the file watcher, so they are a lower bound.',
          )}
        </div>
      </Section>

      <Section title={localize('perforceSyncHistory.section.engine', 'How it ran')}>
        <dl className={styles['kv']}>
          <dt>{localize('perforceSyncHistory.field.engine', 'Engine')}</dt>
          <dd data-testid="perforce-sync-history-detail-engine">
            {detail.engine !== undefined
              ? engineLabel(detail)
              : localize('perforceSyncHistory.notRun', 'this get never ran')}
          </dd>
          <dt>{localize('perforceSyncHistory.field.target', 'Target')}</dt>
          <dd data-testid="perforce-sync-history-detail-target">
            {formatTarget(detail.spec)}
            {detail.spec !== '' ? <span className={styles['mono']}> {detail.spec}</span> : null}
          </dd>
          <dt>{localize('perforceSyncHistory.field.force', 'Force')}</dt>
          <dd>
            {detail.force
              ? localize('perforceSyncHistory.yes', 'yes')
              : localize('perforceSyncHistory.no', 'no')}
          </dd>
          <dt>{localize('perforceSyncHistory.field.threads', 'Parallel threads')}</dt>
          <dd data-testid="perforce-sync-history-detail-threads">
            {detail.engine === 'p4delta'
              ? localize('perforceSyncHistory.threadsP4delta', 'not used by δ')
              : detail.parallelThreads !== undefined
                ? detail.parallelThreads === 0
                  ? localize('perforceSyncHistory.threadsSerial', 'serial (0)')
                  : String(detail.parallelThreads)
                : localize('perforceSyncHistory.notRun', 'this get never ran')}
          </dd>
        </dl>
      </Section>

      <Section title={localize('perforceSyncHistory.section.scope', 'Scope')}>
        <dl className={styles['kv']}>
          <dt>{localize('perforceSyncHistory.field.clientRoot', 'Workspace')}</dt>
          <dd className={styles['mono']}>{detail.clientRoot}</dd>
        </dl>
        <ul className={styles['scopeList']} data-testid="perforce-sync-history-detail-scope">
          {scope.paths.map((path, index) => (
            <li key={`${index}:${path}`} className={styles['mono']}>
              {path}
            </li>
          ))}
        </ul>
        {scope.omitted > 0 && (
          <div className={styles['muted']}>
            {localize('perforceSyncHistory.scopeOmitted', '…and {0} more', {
              0: String(scope.omitted),
            })}
          </div>
        )}
        {detail.scopeNarrowed && (
          <div className={styles['muted']} data-testid="perforce-sync-history-detail-narrowed">
            {localize(
              'perforceSyncHistory.scopeNarrowed',
              'The workspace scope was in the way, so this get ran over the scope instead.',
            )}
          </div>
        )}
      </Section>

      <Section title={localize('perforceSyncHistory.section.trigger', 'Started from')}>
        <div data-testid="perforce-sync-history-detail-trigger">{triggerLabel(detail.trigger)}</div>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles['section']}>
      <h2 className={styles['sectionTitle']}>{title}</h2>
      {children}
    </section>
  )
}
