/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SwarmReviewsView — the Swarm Reviews sidebar viewlet. Loads the action
 *  dashboard (needs-my-action / authored / participating) through the extension's
 *  contributed commands, renders each group with a state badge + vote / comment /
 *  task counts, and opens a review's detail tab on click. A keyword filter box
 *  re-queries the list. All wire logic lives behind ICommandService — this
 *  component owns no HTTP. Mirrors ExtensionsView / PerforceGraphEditor patterns.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  ChevronDown,
  ChevronRight,
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
import { ICommandService, IEditorService, localize } from '@universe-editor/platform'
import { Input, Spinner, cx } from '@universe-editor/workbench-ui'
import {
  SwarmCommands,
  type SwarmDashboardResult,
  type SwarmReviewDto,
} from '@universe-editor/extensions-common'
import { useService } from '../useService.js'
import { SwarmReviewEditorInput } from '../../services/editor/SwarmReviewEditorInput.js'
import { swarmReviewsViewState } from '../../services/swarm/swarmViewState.js'
import styles from './SwarmReviewsView.module.css'

const KEYWORD_DEBOUNCE_MS = 300

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

type GroupKey = 'needsAction' | 'authored'

const GROUP_LABELS: Record<GroupKey, string> = {
  needsAction: localize('swarm.group.needsAction', 'Needs My Action'),
  authored: localize('swarm.group.authored', 'Authored by Me'),
}

const GROUP_KEYS: GroupKey[] = ['needsAction', 'authored']

export function SwarmReviewsView() {
  const commands = useService(ICommandService)
  const editorService = useService(IEditorService)

  const [dashboard, setDashboard] = useState<SwarmDashboardResult | null>(
    swarmReviewsViewState.dashboard,
  )
  const [keyword, setKeyword] = useState(swarmReviewsViewState.keyword)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({
    needsAction: false,
    authored: false,
  })
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(
    (attempt = 0) => {
      setLoading(true)
      setError(null)
      void commands
        .executeCommand<SwarmDashboardResult>(SwarmCommands.dashboard)
        .then((r) => {
          // `undefined` means the perforce extension host hasn't registered the
          // command yet (activation races the view's first mount). Retry with a
          // short backoff instead of caching an empty dashboard forever.
          if (r === undefined) {
            if (attempt < 20) setTimeout(() => load(attempt + 1), 250)
            return
          }
          setDashboard(r)
          swarmReviewsViewState.dashboard = r
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false))
    },
    [commands],
  )

  useEffect(() => {
    // Always refresh when the view (re)mounts — it only mounts while visible, so
    // this is effectively "refresh on open". Any cached dashboard still paints
    // instantly (stale-while-revalidate); a first load that raced the extension
    // host's activation (command returns undefined) retries until it resolves.
    load()
  }, [load])

  const onKeywordChange = useCallback(
    (value: string) => {
      setKeyword(value)
      swarmReviewsViewState.keyword = value
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => load(), KEYWORD_DEBOUNCE_MS)
    },
    [load],
  )

  const openReview = useCallback(
    (id: string) => {
      void editorService.openEditor(new SwarmReviewEditorInput(id))
    },
    [editorService],
  )

  const toggle = useCallback((key: GroupKey) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const kw = keyword.trim().toLowerCase()
  const filterReviews = (reviews: SwarmReviewDto[]): SwarmReviewDto[] =>
    kw
      ? reviews.filter(
          (r) =>
            r.description.toLowerCase().includes(kw) ||
            r.id.includes(kw) ||
            r.author.toLowerCase().includes(kw),
        )
      : reviews

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
      </div>
      <div className={styles['scroll']}>
        {error && <div className={styles['error']}>{error}</div>}
        {!error && dashboard === null && !loading && (
          <div className={styles['message']}>
            {localize('swarm.notConfigured', 'Swarm is not configured. Set perforce.swarm.url.')}
          </div>
        )}
        {dashboard &&
          GROUP_KEYS.map((key) => {
            const reviews = filterReviews(dashboard[key])
            return (
              <ReviewGroup
                key={key}
                label={GROUP_LABELS[key]}
                reviews={reviews}
                collapsed={collapsed[key]}
                onToggle={() => toggle(key)}
                onOpen={openReview}
              />
            )
          })}
        {dashboard &&
          !loading &&
          dashboard.needsAction.length === 0 &&
          dashboard.authored.length === 0 && (
            <div className={styles['message']}>{localize('swarm.empty', 'No reviews found.')}</div>
          )}
      </div>
    </div>
  )
}

function ReviewGroup({
  label,
  reviews,
  collapsed,
  onToggle,
  onOpen,
}: {
  label: string
  reviews: SwarmReviewDto[]
  collapsed: boolean
  onToggle: () => void
  onOpen: (id: string) => void
}) {
  return (
    <div className={styles['section']}>
      <button className={styles['sectionHeader']} onClick={onToggle} type="button">
        {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        <span className={styles['sectionTitle']}>{label}</span>
        <span className={styles['count']}>{reviews.length}</span>
      </button>
      {!collapsed &&
        reviews.map((review) => <ReviewRow key={review.id} review={review} onOpen={onOpen} />)}
    </div>
  )
}

function ReviewRow({ review, onOpen }: { review: SwarmReviewDto; onOpen: (id: string) => void }) {
  const stateIcon = STATE_ICON[review.state]
  const StateIcon = stateIcon?.icon
  return (
    <div className={styles['row']} onClick={() => onOpen(review.id)} data-testid="swarm-review-row">
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
        <span className={styles['reviewId']}>#{review.id}</span>
        <span className={styles['desc']} title={review.description}>
          {review.description || localize('swarm.noDescription', '(no description)')}
        </span>
      </div>
      <div className={styles['rowMeta']}>
        <span className={cx(styles['metaItem'], styles['metaTime'])}>
          {relativeTime(review.updated)}
        </span>
        <span className={styles['metaItem']}>{review.author}</span>
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
