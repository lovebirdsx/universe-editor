/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmReviewsView — the Swarm Reviews sidebar viewlet. Loads the action
 *  dashboard (needs-my-action / authored / participating) through the extension's
 *  contributed commands, renders each group with a state badge + vote / comment /
 *  task counts, and opens a review's detail tab on click. A keyword filter box
 *  re-queries the list. All wire logic lives behind ICommandService — this
 *  component owns no HTTP. Mirrors ExtensionsView / PerforceGraphEditor patterns.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ChevronDown,
  ChevronRight,
  Filter,
  FilterX,
  GitBranch,
  ListFilter,
  MessageSquare,
  ListChecks,
  Check,
  X,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Archive,
} from 'lucide-react'
import {
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorService,
  IOpenerService,
  IQuickInputService,
  IStorageService,
  ConfigurationTarget,
  localize,
} from '@universe-editor/platform'
import { IconButton, Input, Spinner, cx, useScrollRestore } from '@universe-editor/workbench-ui'
import {
  SwarmCommands,
  type SwarmDashboardResult,
  type SwarmGetReviewRequest,
  type SwarmReviewDetailDto,
  type SwarmReviewDto,
  type SwarmTransitionDto,
  type SwarmTransitionRequest,
} from '@universe-editor/extensions-common'
import { useService } from '../useService.js'
import { SwarmReviewEditorInput } from '../../services/editor/SwarmReviewEditorInput.js'
import {
  resolveSwarmReviewsRefresh,
  swarmNeedsActionCount,
  swarmReviewsViewState,
  swarmReviewEvents,
  trackSwarmRefreshConsumer,
} from '../../services/swarm/swarmViewState.js'
import {
  swarmIgnoreStore,
  splitIgnored,
  reviewDtoFromDetail,
} from '../../services/swarm/swarmIgnoreStore.js'
import { swarmReviewsUiStore } from '../../services/swarm/swarmReviewsUiStore.js'
import { buildSwarmReviewUrl } from '../../services/swarm/swarmReviewUrl.js'
import {
  canApproveReview,
  filterAuthored,
  filterNeedsAction,
  readSwarmFilterConfig,
  SwarmFilterConfigKeys,
  type SwarmReviewFilterConfig,
} from '../../services/swarm/swarmReviewFilter.js'
import { configureNeedsActionFilter } from '../../services/swarm/swarmFilterPicker.js'
import {
  SwarmReviewContextMenu,
  type SwarmReviewContextMenuState,
  type SwarmReviewMenuItem,
} from './SwarmReviewContextMenu.js'
import styles from './SwarmReviewsView.module.css'

const KEYWORD_DEBOUNCE_MS = 300

export function swarmReviewName(review: SwarmReviewDto): string {
  return review.description.trim() || `Review #${review.id}`
}

export { canApproveReview }

function isDangerousTransition(state: string): boolean {
  return state.includes('commit') || state === 'rejected' || state === 'archived'
}

/** Per-state colored icon — replaces the wide text badge to save horizontal space. */
const STATE_ICON: Record<string, { icon: LucideIcon; className: string | undefined }> = {
  needsReview: { icon: Circle, className: styles['stateNeedsReview'] },
  needsRevision: { icon: CircleAlert, className: styles['stateNeedsRevision'] },
  approved: { icon: CircleCheck, className: styles['stateApproved'] },
  rejected: { icon: CircleX, className: styles['stateRejected'] },
  archived: { icon: Archive, className: styles['stateArchived'] },
}

/** Relative last-updated label, matching the agent session history wording. */
function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return localize('agent.history.justNow', 'just now')
  if (diff < 3_600_000)
    return localize('agent.history.minutesAgo', '{count}m ago', {
      count: Math.floor(diff / 60_000),
    })
  if (diff < 86_400_000)
    return localize('agent.history.hoursAgo', '{count}h ago', {
      count: Math.floor(diff / 3_600_000),
    })
  return localize('agent.history.daysAgo', '{count}d ago', {
    count: Math.floor(diff / 86_400_000),
  })
}

type GroupKey = 'needsAction' | 'ignored' | 'authored'

const GROUP_LABELS: Record<GroupKey, string> = {
  needsAction: localize('swarm.group.needsAction', 'Needs My Action'),
  ignored: localize('swarm.group.ignored', 'Ignored'),
  authored: localize('swarm.group.authored', 'Authored by Me'),
}

const GROUP_KEYS: GroupKey[] = ['needsAction', 'ignored', 'authored']

export function SwarmReviewsView() {
  const commands = useService(ICommandService)
  const configuration = useService(IConfigurationService)
  const dialog = useService(IDialogService)
  const editorService = useService(IEditorService)
  const opener = useService(IOpenerService)
  const quickInput = useService(IQuickInputService)
  const storage = useService(IStorageService)

  const [dashboard, setDashboard] = useState<SwarmDashboardResult | null>(
    swarmReviewsViewState.dashboard,
  )
  const [keyword, setKeyword] = useState(swarmReviewsUiStore.keyword)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>(
    () => swarmReviewsUiStore.collapsed,
  )
  const [transitions, setTransitions] = useState<Record<string, SwarmTransitionDto[]>>(
    swarmReviewsViewState.transitions,
  )
  const [filterConfig, setFilterConfig] = useState<SwarmReviewFilterConfig>(() =>
    readSwarmFilterConfig(configuration),
  )
  const [menu, setMenu] = useState<SwarmReviewContextMenuState | null>(null)
  // Bumped whenever the ignore store changes, so grouping recomputes. The store is
  // a module singleton (shared with the review editor); we read it live below.
  const [, setIgnoreVersion] = useState(0)
  // Gate the first render until the persisted ignore set has hydrated, so an
  // ignored review never flashes in "Needs My Action" before splitIgnored can
  // reclassify it. The contribution attaches the store at app start, so this is
  // usually already true on mount.
  const [ignoreReady, setIgnoreReady] = useState(() => swarmIgnoreStore.isReady)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Ids whose stale ignore-snapshot already got a detail-fetch heal attempt this
  // mount — keeps a genuinely blank description from re-fetching on every poll.
  const healAttemptedRef = useRef<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useScrollRestore(
    'swarmReviews',
    useCallback(() => scrollRef.current, []),
  )
  const transitionsRef = useRef<Record<string, SwarmTransitionDto[]>>(
    swarmReviewsViewState.transitions,
  )
  // Latest keyword, read inside `load` so its identity stays stable (the query is
  // pushed down to the server; `load` must not be recreated on every keystroke).
  const keywordRef = useRef(keyword)

  const loadTransitions = useCallback(
    async (reviewId: string, force = false): Promise<SwarmTransitionDto[]> => {
      if (!force) {
        const cached = transitionsRef.current[reviewId]
        if (cached) return cached
      }
      const result =
        (await commands.executeCommand<SwarmTransitionDto[]>(
          SwarmCommands.getTransitions,
          reviewId,
        )) ?? []
      // Merge (never replace wholesale) so a forced refresh updates one review's
      // verdict without dropping the others — keeping the approvable filter stable
      // instead of briefly widening the list while verdicts reload.
      transitionsRef.current = { ...transitionsRef.current, [reviewId]: result }
      swarmReviewsViewState.transitions = transitionsRef.current
      setTransitions((prev) => ({ ...prev, [reviewId]: result }))
      return result
    },
    [commands],
  )

  const load = useCallback(
    (attempt = 0, force = false): Promise<void> => {
      setLoading(true)
      setError(null)
      const keywords = keywordRef.current.trim()
      return commands
        .executeCommand<SwarmDashboardResult>(SwarmCommands.dashboard, {
          force,
          withStream: true,
          ...(keywords ? { keywords } : {}),
        })
        .then((r) => {
          // `undefined` means the perforce extension host hasn't registered the
          // command yet (activation races the view's first mount). Retry with a
          // short backoff instead of caching an empty dashboard forever. Chained
          // so the returned promise (and the loading flag) covers the retries.
          if (r === undefined) {
            if (attempt < 20) {
              return new Promise<void>((res) =>
                setTimeout(() => res(load(attempt + 1, force)), 250),
              )
            }
            return
          }
          setDashboard(r)
          swarmReviewsViewState.dashboard = r
          // Refresh ignore-snapshots with live rows — a snapshot frozen before a
          // parser fix (e.g. a blank-first-line description stored as '') would
          // otherwise render stale in the IGNORED group.
          for (const review of r.needsAction) {
            if (swarmIgnoreStore.isIgnored(review.id)) swarmIgnoreStore.refreshMeta(review)
          }
          // On a forced reload, re-fetch each verdict but keep the previous one
          // visible until it resolves (loadTransitions merges), so an active
          // approvable filter never briefly widens the list.
          const staleIds = new Set(Object.keys(transitionsRef.current))
          for (const review of r.needsAction) {
            void loadTransitions(review.id, force).catch(() => {})
            staleIds.delete(review.id)
          }
          // Drop verdicts for reviews no longer in the needs-action set.
          if (staleIds.size > 0) {
            for (const id of staleIds) delete transitionsRef.current[id]
            swarmReviewsViewState.transitions = transitionsRef.current
            setTransitions((prev) => {
              const next = { ...prev }
              for (const id of staleIds) delete next[id]
              return next
            })
          }
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
    },
    [commands, loadTransitions],
  )

  useEffect(() => {
    // Always refresh when the view (re)mounts — it only mounts while visible, so
    // this is effectively "refresh on open". Any cached dashboard still paints
    // instantly (stale-while-revalidate); a first load that raced the extension
    // host's activation (command returns undefined) retries until it resolves.
    void load()
  }, [load])

  // Force the extension host to bypass its short-lived review-list cache and
  // re-derive the approvable icons. Used when a review mutated (in a detail tab)
  // or the user hit manual refresh. Verdicts are refreshed in place (load →
  // loadTransitions with force), never wiped first, so an active approvable
  // filter keeps the list narrow instead of flashing the full list.
  const reload = useCallback((): Promise<void> => load(0, true), [load])

  useEffect(() => {
    // The title-bar Refresh command awaits its request promise for the button's
    // disabled/spinning state — settle it only after this triggered reload.
    const consumer = trackSwarmRefreshConsumer()
    const d1 = swarmReviewEvents.onDidMutateReview(() => {
      void reload()
    })
    const d2 = swarmReviewEvents.onDidRequestRefresh(() => {
      void reload().finally(() => resolveSwarmReviewsRefresh())
    })
    return () => {
      consumer.dispose()
      d1.dispose()
      d2.dispose()
    }
  }, [reload])

  // Bind the ignore store to storage (idempotent) and re-render on any change,
  // whether it originated here or in a review detail tab.
  useEffect(() => {
    void swarmIgnoreStore.attach(storage)
    const sub = swarmIgnoreStore.onDidChange(() => {
      setIgnoreReady(swarmIgnoreStore.isReady)
      setIgnoreVersion((v) => v + 1)
    })
    return () => sub.dispose()
  }, [storage])

  // Heal ignore-snapshots the dashboard no longer returns: a blank snapshot
  // description means it was frozen before blank-first-line descriptions were
  // parsed correctly, so fetch the detail once (per mount) and rebuild the
  // snapshot from it.
  useEffect(() => {
    if (!dashboard || !ignoreReady) return
    const liveIds = new Set(dashboard.needsAction.map((r) => r.id))
    for (const id of swarmIgnoreStore.list()) {
      if (liveIds.has(id) || healAttemptedRef.current.has(id)) continue
      const meta = swarmIgnoreStore.getMeta(id)
      if (!meta || meta.description.trim()) continue
      healAttemptedRef.current.add(id)
      void commands
        .executeCommand<SwarmReviewDetailDto | undefined>(SwarmCommands.getReview, {
          reviewId: id,
        } satisfies SwarmGetReviewRequest)
        .then((detail) => {
          if (detail) swarmIgnoreStore.refreshMeta(reviewDtoFromDetail(detail, meta))
        })
        .catch(() => {})
    }
  }, [dashboard, ignoreReady, commands])

  // Hydrate + track the persisted sidebar UI state (group collapse + keyword).
  // The contribution attaches it at app start; re-sync local state on hydrate so
  // the saved collapse / keyword paint even if this view mounted first.
  useEffect(() => {
    void swarmReviewsUiStore.attach(storage)
    const sub = swarmReviewsUiStore.onDidChange(() => {
      setCollapsed(swarmReviewsUiStore.collapsed)
      const stored = swarmReviewsUiStore.keyword
      if (stored !== keywordRef.current) {
        keywordRef.current = stored
        setKeyword(stored)
        // Keyword is pushed down to the server query; re-load so restored text
        // narrows the list server-side, not just via the client-side filter.
        void load()
      }
    })
    return () => sub.dispose()
  }, [storage, load])

  // Keep the local filter snapshot in sync with settings.json edits (from the
  // gear menu, the authored toggle, or a hand edit) so the list re-renders.
  useEffect(() => {
    const sub = configuration.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(SwarmFilterConfigKeys.needsActionAuthors) ||
        e.affectsConfiguration(SwarmFilterConfigKeys.needsActionApprovableOnly) ||
        e.affectsConfiguration(SwarmFilterConfigKeys.authoredHideApproved)
      ) {
        setFilterConfig(readSwarmFilterConfig(configuration))
      }
    })
    return () => sub.dispose()
  }, [configuration])

  const onKeywordChange = useCallback(
    (value: string) => {
      setKeyword(value)
      swarmReviewsUiStore.setKeyword(value)
      keywordRef.current = value
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => void load(), KEYWORD_DEBOUNCE_MS)
    },
    [load],
  )

  const openReview = useCallback(
    (id: string) => {
      void editorService.openEditor(new SwarmReviewEditorInput(id))
    },
    [editorService],
  )

  const ignoreReview = useCallback((review: SwarmReviewDto) => {
    swarmIgnoreStore.ignore(review)
  }, [])

  const unignoreReview = useCallback((reviewId: string) => {
    swarmIgnoreStore.unignore(reviewId)
  }, [])

  const toggle = useCallback((key: GroupKey) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      swarmReviewsUiStore.setCollapsed(key, next[key])
      return next
    })
  }, [])

  const reviewUrl = useCallback(
    (reviewId: string) =>
      buildSwarmReviewUrl(configuration.get<string>('perforce.swarm.url'), reviewId),
    [configuration],
  )

  const applyTransition = useCallback(
    async (review: SwarmReviewDto, transition: SwarmTransitionDto) => {
      if (isDangerousTransition(transition.state)) {
        const result = await dialog.confirm({
          type: 'warning',
          message: localize('swarm.transition.confirm', '{0} review #{1}?', {
            0: transition.label,
            1: review.id,
          }),
          detail: localize(
            'swarm.transition.confirmDetail',
            'This review operation may be irreversible.',
          ),
          primaryButton: transition.label,
        })
        if (!result.confirmed) return
      }
      const request: SwarmTransitionRequest = { reviewId: review.id, state: transition.state }
      if (transition.state.includes('commit')) request.commit = true
      await commands.executeCommand(SwarmCommands.transition, request)
      void reload()
    },
    [commands, dialog, reload],
  )

  const obliterateReview = useCallback(
    async (review: SwarmReviewDto) => {
      const result = await dialog.confirm({
        type: 'warning',
        message: localize('swarm.obliterate.confirm', 'Obliterate review #{0}?', { 0: review.id }),
        detail: localize(
          'swarm.obliterate.confirmDetail',
          'This permanently discards the review and cannot be undone.',
        ),
        primaryButton: localize('swarm.obliterate.action', 'Obliterate Review'),
      })
      if (!result.confirmed) return
      const succeeded = await commands.executeCommand<boolean>(SwarmCommands.obliterateReview, {
        reviewId: review.id,
      })
      if (!succeeded) return
      void reload()
    },
    [commands, dialog, reload],
  )

  const createMenuItems = useCallback(
    (
      review: SwarmReviewDto,
      allowedTransitions: readonly SwarmTransitionDto[],
    ): SwarmReviewMenuItem[] => {
      const url = reviewUrl(review.id)
      const transitionItems: SwarmReviewMenuItem[] = allowedTransitions.map((transition) => ({
        kind: 'item',
        label: transition.label,
        danger: isDangerousTransition(transition.state),
        run: () => void applyTransition(review, transition),
      }))
      return [
        {
          kind: 'item',
          label: localize('swarm.menu.open', 'Open Review'),
          run: () => openReview(review.id),
        },
        ...(url
          ? ([
              {
                kind: 'item',
                label: localize('swarm.menu.openBrowser', 'Open Review in Browser'),
                run: () => void opener.open(url, { fromUserGesture: true }),
              },
            ] satisfies SwarmReviewMenuItem[])
          : []),
        { kind: 'separator' },
        swarmIgnoreStore.isIgnored(review.id)
          ? {
              kind: 'item',
              label: localize('swarm.menu.unignore', 'Unignore Review'),
              run: () => unignoreReview(review.id),
            }
          : {
              kind: 'item',
              label: localize('swarm.menu.ignore', 'Ignore Review'),
              run: () => ignoreReview(review),
            },
        ...(transitionItems.length > 0
          ? ([{ kind: 'separator' }, ...transitionItems] satisfies SwarmReviewMenuItem[])
          : []),
        { kind: 'separator' },
        {
          kind: 'item',
          label: localize('swarm.menu.copyName', 'Copy Review Name'),
          run: () => void navigator.clipboard?.writeText(swarmReviewName(review)),
        },
        ...(url
          ? ([
              {
                kind: 'item',
                label: localize('swarm.menu.copyLink', 'Copy Review Link'),
                run: () => void navigator.clipboard?.writeText(url),
              },
            ] satisfies SwarmReviewMenuItem[])
          : []),
        { kind: 'separator' },
        {
          kind: 'item',
          label: localize('swarm.obliterate.action', 'Obliterate Review'),
          danger: true,
          run: () => void obliterateReview(review),
        },
      ]
    },
    [
      applyTransition,
      obliterateReview,
      openReview,
      opener,
      reviewUrl,
      ignoreReview,
      unignoreReview,
    ],
  )

  const openReviewMenu = useCallback(
    (event: ReactMouseEvent, review: SwarmReviewDto) => {
      event.preventDefault()
      event.stopPropagation()
      const x = event.clientX
      const y = event.clientY
      const show = (allowedTransitions: readonly SwarmTransitionDto[]) =>
        setMenu({ x, y, reviewId: review.id, items: createMenuItems(review, allowedTransitions) })
      show(transitionsRef.current[review.id] ?? [])
      if (!transitionsRef.current[review.id]) {
        void loadTransitions(review.id)
          .then((result) => {
            setMenu((current) =>
              current?.reviewId === review.id
                ? { ...current, items: createMenuItems(review, result) }
                : current,
            )
          })
          .catch(() => {})
      }
    },
    [createMenuItems, loadTransitions],
  )

  const kw = keyword.trim().toLowerCase()
  const filterKeyword = (reviews: SwarmReviewDto[]): SwarmReviewDto[] =>
    kw
      ? reviews.filter(
          (r) =>
            r.description.toLowerCase().includes(kw) ||
            r.id.includes(kw) ||
            r.author.toLowerCase().includes(kw),
        )
      : reviews

  // Ignored reviews are pulled out of "Needs My Action" into their own group.
  // The group's data comes from the live dashboard when still present, falling
  // back to the snapshot captured at ignore time (the dashboard may no longer
  // return it — e.g. its author left the needsActionAuthors filter).
  const ignoredIds = new Set(swarmIgnoreStore.list())
  const { active: needsActionActive, ignored: needsActionIgnored } = splitIgnored(
    dashboard ? filterNeedsAction(dashboard.needsAction, filterConfig, transitions) : [],
    ignoredIds,
  )

  // Publish the group-scope count (keyword excluded) for the Activity Bar badge;
  // the background notification poll keeps it fresh while this view is closed.
  const needsActionCount = needsActionActive.length
  useEffect(() => {
    swarmNeedsActionCount.set(dashboard ? needsActionCount : 0)
  }, [dashboard, needsActionCount])
  const ignoredReviews: SwarmReviewDto[] = (() => {
    if (ignoredIds.size === 0) return []
    const byId = new Map<string, SwarmReviewDto>()
    for (const r of needsActionIgnored) byId.set(r.id, r)
    for (const id of ignoredIds) {
      if (byId.has(id)) continue
      const meta = swarmIgnoreStore.getMeta(id)
      if (meta) byId.set(id, meta)
    }
    return [...byId.values()]
  })()

  const groupedReviews: Record<GroupKey, SwarmReviewDto[]> = {
    needsAction: filterKeyword(needsActionActive),
    ignored: filterKeyword(ignoredReviews),
    authored: dashboard ? filterAuthored(filterKeyword(dashboard.authored), filterConfig) : [],
  }

  const toggleAuthoredHideApproved = useCallback(() => {
    configuration.update(
      SwarmFilterConfigKeys.authoredHideApproved,
      !filterConfig.authoredHideApproved,
      ConfigurationTarget.User,
    )
  }, [configuration, filterConfig.authoredHideApproved])

  const openNeedsActionFilter = useCallback(() => {
    const authors = dashboard ? [...new Set(dashboard.needsAction.map((r) => r.author))] : []
    void configureNeedsActionFilter(quickInput, configuration, filterConfig, authors)
  }, [configuration, dashboard, filterConfig, quickInput])

  const needsActionFilterActive =
    filterConfig.needsActionAuthors.length > 0 || filterConfig.needsActionApprovableOnly

  return (
    <div className={styles['container']} data-testid="swarm-reviews-view">
      <div className={styles['filterRow']}>
        <Input
          className={styles['filterInput']}
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          placeholder={localize('swarm.filter.placeholder', 'Filter reviews…')}
        />
        {loading && <Spinner />}
        <IconButton
          active={needsActionFilterActive}
          label={localize('swarm.filter.needsAction.tooltip', 'Filter "Needs My Action"')}
          onClick={openNeedsActionFilter}
          data-testid="swarm-needs-action-filter"
        >
          <ListFilter size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          active={filterConfig.authoredHideApproved}
          label={
            filterConfig.authoredHideApproved
              ? localize('swarm.filter.authored.showApproved', 'Show approved authored reviews')
              : localize('swarm.filter.authored.hideApproved', 'Hide approved authored reviews')
          }
          onClick={toggleAuthoredHideApproved}
          data-testid="swarm-authored-hide-approved"
        >
          {filterConfig.authoredHideApproved ? (
            <FilterX size={14} strokeWidth={1.75} />
          ) : (
            <Filter size={14} strokeWidth={1.75} />
          )}
        </IconButton>
      </div>
      <div className={styles['scroll']} ref={scrollRef}>
        {error && <div className={styles['error']}>{error}</div>}
        {!error && dashboard === null && !loading && (
          <div className={styles['message']}>
            {localize('swarm.notConfigured', 'Swarm is not configured. Set perforce.swarm.url.')}
          </div>
        )}
        {(dashboard || groupedReviews.ignored.length > 0) &&
          ignoreReady &&
          GROUP_KEYS.filter((key) => key !== 'ignored' || groupedReviews.ignored.length > 0).map(
            (key) => (
              <ReviewGroup
                key={key}
                label={GROUP_LABELS[key]}
                reviews={groupedReviews[key]}
                collapsed={collapsed[key]}
                onToggle={() => toggle(key)}
                onOpen={openReview}
                onContextMenu={openReviewMenu}
                transitions={transitions}
              />
            ),
          )}
        {dashboard &&
          !loading &&
          dashboard.needsAction.length === 0 &&
          dashboard.authored.length === 0 && (
            <div className={styles['message']}>{localize('swarm.empty', 'No reviews found.')}</div>
          )}
      </div>
      {menu && <SwarmReviewContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

function ReviewGroup({
  label,
  reviews,
  collapsed,
  onToggle,
  onOpen,
  onContextMenu,
  transitions,
}: {
  label: string
  reviews: SwarmReviewDto[]
  collapsed: boolean
  onToggle: () => void
  onOpen: (id: string) => void
  onContextMenu: (event: ReactMouseEvent, review: SwarmReviewDto) => void
  transitions: Readonly<Record<string, SwarmTransitionDto[]>>
}) {
  return (
    <div className={styles['section']}>
      <button className={styles['sectionHeader']} onClick={onToggle} type="button">
        {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        <span className={styles['sectionTitle']}>{label}</span>
        <span className={styles['count']}>{reviews.length}</span>
      </button>
      {!collapsed &&
        reviews.map((review) => (
          <ReviewRow
            key={review.id}
            review={review}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            canApprove={canApproveReview(transitions[review.id])}
          />
        ))}
    </div>
  )
}

function ReviewRow({
  review,
  onOpen,
  onContextMenu,
  canApprove,
}: {
  review: SwarmReviewDto
  onOpen: (id: string) => void
  onContextMenu: (event: ReactMouseEvent, review: SwarmReviewDto) => void
  canApprove: boolean
}) {
  const stateIcon =
    review.state === 'needsReview' && canApprove
      ? { icon: CircleCheck, className: styles['stateCanApprove'] }
      : STATE_ICON[review.state]
  const StateIcon = stateIcon?.icon
  return (
    <div
      className={styles['row']}
      onClick={() => onOpen(review.id)}
      onContextMenu={(event) => onContextMenu(event, review)}
      data-testid="swarm-review-row"
    >
      <div className={styles['rowTop']}>
        {StateIcon && (
          <span
            className={cx(styles['stateIcon'], stateIcon.className)}
            title={review.stateLabel}
            aria-label={review.stateLabel}
          >
            <StateIcon size={13} />
          </span>
        )}
        <span className={styles['desc']} title={review.description}>
          {review.description || localize('swarm.noDescription', '(no description)')}
        </span>
      </div>
      <div className={styles['rowMeta']}>
        <span className={cx(styles['metaItem'], styles['metaTime'])}>
          {relativeTime(review.updated)}
        </span>
        <span className={styles['metaItem']}>{review.author}</span>
        {review.stream && (
          <span className={cx(styles['metaItem'], styles['metaStream'])} title={review.stream}>
            <GitBranch size={11} />
            <span className={styles['metaStreamText']}>{review.stream}</span>
          </span>
        )}
        {review.upVotes > 0 && <span className={styles['metaItem']}>↑{review.upVotes}</span>}
        {review.downVotes > 0 && <span className={styles['metaItem']}>↓{review.downVotes}</span>}
        {review.commentCount > 0 && (
          <span className={styles['metaItem']}>
            <MessageSquare size={11} />
            {review.commentCount}
          </span>
        )}
        {review.openTaskCount > 0 && (
          <span className={styles['metaItem']}>
            <ListChecks size={11} />
            {review.openTaskCount}
          </span>
        )}
        {review.testStatus === 'pass' && (
          <span className={cx(styles['metaItem'], styles['testPass'])}>
            <Check size={11} />
          </span>
        )}
        {review.testStatus === 'fail' && (
          <span className={cx(styles['metaItem'], styles['testFail'])}>
            <X size={11} />
          </span>
        )}
      </div>
    </div>
  )
}
