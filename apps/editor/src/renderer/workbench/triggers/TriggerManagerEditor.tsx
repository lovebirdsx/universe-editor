/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerManagerEditor — the single manager tab (left: grouped trigger list with
 *  search and pause toggles; right: overview / configuration / run history).
 *  Data comes from ITriggerMainService only; a change event replaces the whole
 *  list, so selection is re-resolved against the fresh summaries. Search, selection,
 *  the active tab and scroll positions persist through IStorageService, so closing
 *  and reopening the tab restores the previous view (see useTriggerManagerViewState).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FileJson,
  Filter,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
} from 'lucide-react'
import { localize, type IEditorInput, type URI } from '@universe-editor/platform'
import {
  Badge,
  Button,
  IconButton,
  Input,
  ListMenu,
  Toggle,
  cx,
  useFlatListNavigation,
} from '@universe-editor/workbench-ui'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import {
  groupTriggersByWorkspace,
  relativeTimeUntil,
  sortTriggersForDisplay,
  summarizeTriggerSource,
  triggerCanRun,
  triggerMatchesListFilter,
  triggerMatchesSearch,
  triggerNeedsConfirmation,
  triggerStatusBadge,
  type TriggerListFilter,
} from '../../../shared/triggers/triggerPresentation.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { relativeTime } from '../../relativeTime.js'
import { TriggerManagerEditorInput } from '../../services/triggers/triggerManagerEditorInput.js'
import { useService } from '../useService.js'
import { triggerRunOutcomeLabel } from '../agents/automationLabels.js'
import { errorText } from './triggerFormParts.js'
import styles from './TriggerManager.module.css'
import { TriggerConfigPanel } from './TriggerConfigPanel.js'
import { TriggerCreateWizard } from './TriggerCreateWizard.js'
import { TriggerOverviewPanel } from './TriggerOverviewPanel.js'
import { TriggerRunsPanel } from './TriggerRunsPanel.js'
import type { TriggerManagerActions } from './useTriggerActions.js'
import { useTriggerActions } from './useTriggerActions.js'
import { useTriggerManagerViewState, type TriggerTab } from './useTriggerManagerViewState.js'

export interface TriggerManagerEditorProps {
  readonly input: IEditorInput
}

const TABS: readonly { readonly id: TriggerTab; readonly label: string }[] = [
  { id: 'overview', label: localize('trigger.manager.overview.title', 'Overview') },
  {
    id: 'configuration',
    label: localize('trigger.manager.overview.configuration', 'Configuration'),
  },
  { id: 'runs', label: localize('trigger.manager.overview.runs', 'Run history') },
]

const FILTER_OPTIONS: readonly { readonly value: TriggerListFilter; readonly label: string }[] = [
  { value: 'all', label: localize('trigger.manager.filter.all', 'All triggers') },
  { value: 'active', label: localize('trigger.manager.filter.active', 'Active') },
  { value: 'attention', label: localize('trigger.manager.filter.attention', 'Needs attention') },
  { value: 'paused', label: localize('trigger.manager.filter.paused', 'Paused') },
]

const TIME_TICK_MS = 30_000

/** Bound how long a created trigger waits for its summary to appear in the list. */
const CREATED_SELECTION_TIMEOUT_MS = 15_000

export function TriggerManagerEditor({ input }: TriggerManagerEditorProps) {
  const triggers = useService(ITriggerMainService)
  const actions = useTriggerActions()
  const managerInput = input instanceof TriggerManagerEditorInput ? input : undefined

  const [summaries, setSummaries] = useState<readonly TriggerSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [createOpen, setCreateOpen] = useState(false)
  const [rescanning, setRescanning] = useState(false)
  const [filterMenu, setFilterMenu] = useState<
    { readonly x: number; readonly y: number } | undefined
  >(undefined)
  const [rowMenu, setRowMenu] = useState<
    { readonly summary: TriggerSummary; readonly x: number; readonly y: number } | undefined
  >(undefined)
  const [pendingCreated, setPendingCreated] = useState<
    { readonly workspace: string; readonly id: string } | undefined
  >(undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const selectionKeys = useMemo(() => new Set(summaries.map((entry) => entry.key)), [summaries])
  const {
    query,
    setQuery,
    filter,
    setFilter,
    collapsedGroups,
    toggleGroup,
    selectedKey,
    selectKey,
    tab,
    switchTab,
  } = useTriggerManagerViewState({
    input: managerInput,
    listRef,
    detailRef,
    listReady: loaded,
    selectionKeys,
  })

  const runRescan = useCallback(async () => {
    setRescanning(true)
    try {
      await actions.rescan()
    } finally {
      setRescanning(false)
    }
  }, [actions])

  // Subscribe before the initial fetch: an update that lands between the fetch
  // and the subscription would otherwise be lost until the next change.
  useEffect(() => {
    let cancelled = false
    const subscription = triggers.onDidChangeTriggers((next) => {
      if (cancelled) return
      setSummaries(next)
      setLoaded(true)
    })
    void triggers.listTriggers().then(
      (next) => {
        if (cancelled) return
        setSummaries(next)
        setLoaded(true)
      },
      (err: unknown) => {
        if (cancelled) return
        setLoadError(errorText(err))
        setLoaded(true)
      },
    )
    return () => {
      cancelled = true
      subscription.dispose()
    }
  }, [triggers])

  // A restored manager tab never runs the open command, so rescan here as well;
  // main treats it as a read-only, idempotent discovery.
  useEffect(() => {
    void runRescan()
  }, [runRescan])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TIME_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  // A created trigger is selected as soon as the scheduler pushes the refreshed
  // list; the key is composed in main from the workspace identity, so match on
  // workspace + id rather than rebuilding the private separator here.
  useEffect(() => {
    if (pendingCreated === undefined) return
    const match = summaries.find(
      (summary) =>
        summary.id === pendingCreated.id &&
        sameWorkspaceIdentity(summary.workspace, pendingCreated.workspace),
    )
    if (match === undefined) return
    setPendingCreated(undefined)
    selectKey(match.key)
    switchTab('configuration')
  }, [pendingCreated, selectKey, summaries, switchTab])

  // If the new definition never reaches the list (watch failed / workspace
  // rejected it), stop treating it as pending instead of waiting forever.
  useEffect(() => {
    if (pendingCreated === undefined) return
    const timer = setTimeout(() => setPendingCreated(undefined), CREATED_SELECTION_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [pendingCreated])

  const openCreateWizard = useCallback(() => setCreateOpen(true), [])
  const handleCreated = useCallback((workspaceUri: URI, triggerId: string) => {
    setCreateOpen(false)
    setPendingCreated({ workspace: workspaceUri.toString(), id: triggerId })
  }, [])

  const matching = useMemo(
    () =>
      summaries.filter(
        (summary) =>
          triggerMatchesListFilter(summary, filter) && triggerMatchesSearch(summary, query),
      ),
    [summaries, filter, query],
  )
  const ordered = useMemo(() => sortTriggersForDisplay(matching), [matching])
  const groups = useMemo(() => groupTriggersByWorkspace(ordered), [ordered])
  const visibleSummaries = useMemo(
    () => groups.flatMap((group) => (collapsedGroups.has(group.workspace) ? [] : group.triggers)),
    [groups, collapsedGroups],
  )
  const indexByKey = useMemo(() => {
    const index = new Map<string, number>()
    visibleSummaries.forEach((summary, position) => index.set(summary.key, position))
    return index
  }, [visibleSummaries])

  const selected =
    (selectedKey !== undefined
      ? summaries.find((summary) => summary.key === selectedKey)
      : undefined) ??
    visibleSummaries[0] ??
    ordered[0] ??
    summaries[0]

  const selectedIndex = selected === undefined ? -1 : visibleSummaries.indexOf(selected)
  const navigation = useFlatListNavigation({
    count: visibleSummaries.length,
    focusedIndex: selectedIndex,
    onFocusChange: (index) => {
      const summary = visibleSummaries[index]
      if (summary !== undefined) selectKey(summary.key)
    },
    getItemKey: (index) => visibleSummaries[index]?.key ?? String(index),
    getContainer: () => listRef.current,
    onActivate: (index) => {
      const summary = visibleSummaries[index]
      if (summary !== undefined) selectKey(summary.key)
    },
    ariaLabel: localize('trigger.manager.list.label', 'Triggers'),
    focusSelectsFirst: false,
  })

  const pendingConfirmation = summaries.filter(triggerNeedsConfirmation)
  const pausedAll = summaries.some((summary) => summary.pausedAll)

  const resumeAll = useCallback(() => {
    void actions.setAllPaused(false)
  }, [actions])

  const pauseAll = useCallback(() => {
    void actions.setAllPaused(true)
  }, [actions])

  return (
    <div className={styles['root']} data-testid="trigger-manager">
      {pendingConfirmation.length > 0 && (
        <button
          type="button"
          className={styles['banner']}
          data-testid="trigger-manager-pending-banner"
          onClick={() => {
            const first = pendingConfirmation[0]
            if (first !== undefined) selectKey(first.key)
          }}
        >
          <span className={styles['bannerIcon']}>⚠</span>
          <span>
            {localize(
              'trigger.manager.pendingBanner',
              '{count} triggers need confirmation before they can run',
              { count: pendingConfirmation.length },
            )}
          </span>
        </button>
      )}
      {pausedAll && (
        <div className={styles['banner']} data-testid="trigger-manager-paused-all-banner">
          <span className={styles['bannerIcon']}>⏸</span>
          <span className={styles['bannerText']}>
            {localize('trigger.manager.pausedAllBanner', 'All triggers are paused.')}
          </span>
          <Button size="sm" onClick={resumeAll} data-testid="trigger-manager-resume-all">
            {localize('trigger.manager.resumeAll', 'Resume all')}
          </Button>
        </div>
      )}

      <div className={styles['panes']}>
        <aside className={styles['listPane']}>
          <div className={styles['toolbar']}>
            <Input
              className={styles['search'] ?? ''}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={localize('trigger.manager.search.placeholder', 'Filter triggers')}
              aria-label={localize('trigger.manager.search.placeholder', 'Filter triggers')}
              data-testid="trigger-manager-search"
            />
            <IconButton
              label={
                filter === 'all'
                  ? localize('trigger.manager.filter.open', 'Filter triggers')
                  : localize('trigger.manager.filter.activeLabel', 'Filter: {filter}', {
                      filter: triggerFilterLabel(filter),
                    })
              }
              active={filter !== 'all'}
              aria-haspopup="menu"
              aria-expanded={filterMenu !== undefined}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                if (filterMenu !== undefined) {
                  setFilterMenu(undefined)
                  return
                }
                const rect = event.currentTarget.getBoundingClientRect()
                setFilterMenu({ x: rect.left, y: rect.bottom })
              }}
              data-testid="trigger-manager-filter"
            >
              <Filter size={14} strokeWidth={1.75} />
            </IconButton>
            <IconButton
              label={localize('trigger.manager.create', 'New trigger')}
              onClick={openCreateWizard}
              data-testid="trigger-manager-create"
            >
              <Plus size={14} strokeWidth={1.75} />
            </IconButton>
            <IconButton
              label={
                pausedAll
                  ? localize('trigger.manager.resumeAll', 'Resume all')
                  : localize('trigger.manager.pauseAll', 'Pause all')
              }
              onClick={pausedAll ? resumeAll : pauseAll}
              data-testid={
                pausedAll ? 'trigger-manager-resume-all-toolbar' : 'trigger-manager-pause-all'
              }
            >
              {pausedAll ? (
                <Play size={14} strokeWidth={1.75} />
              ) : (
                <Pause size={14} strokeWidth={1.75} />
              )}
            </IconButton>
            <IconButton
              label={localize('trigger.manager.openConfig', 'Open triggers.json')}
              onClick={() => void actions.openConfig()}
              data-testid="trigger-manager-open-config"
            >
              <FileJson size={14} strokeWidth={1.75} />
            </IconButton>
            <IconButton
              label={localize('trigger.manager.showLog', 'View log')}
              onClick={() => void actions.showLog()}
              data-testid="trigger-manager-show-log"
            >
              <ScrollText size={14} strokeWidth={1.75} />
            </IconButton>
          </div>

          <div
            {...(summaries.length > 0 ? navigation.containerProps : {})}
            ref={listRef}
            className={styles['list']}
            data-testid="trigger-manager-list"
          >
            {!loaded && (
              <div className={styles['state']} data-testid="trigger-manager-loading">
                {localize('trigger.manager.loading', 'Loading triggers…')}
              </div>
            )}
            {loaded && loadError !== undefined && (
              <div className={styles['state']} data-testid="trigger-manager-load-error">
                {localize('trigger.manager.loadFailed', 'Failed to load triggers: {error}', {
                  error: loadError,
                })}
              </div>
            )}
            {loaded && loadError === undefined && summaries.length === 0 && (
              <div className={styles['emptyState']} data-testid="trigger-manager-empty">
                <div>{localize('trigger.manager.empty', 'No triggers are configured yet.')}</div>
                <div className={styles['emptyHint']}>
                  {localize(
                    'trigger.manager.emptyHint',
                    'If .universe-editor/triggers.json was added by a Git pull or branch switch, rescan the workspace.',
                  )}
                </div>
                <Button
                  size="sm"
                  busy={rescanning}
                  onClick={() => void runRescan()}
                  data-testid="trigger-manager-rescan"
                >
                  <RefreshCw size={14} strokeWidth={1.75} />
                  {localize('trigger.manager.rescan', 'Rescan')}
                </Button>
              </div>
            )}
            {loaded && summaries.length > 0 && matching.length === 0 && (
              <div className={styles['state']} data-testid="trigger-manager-empty-match">
                {localize('trigger.manager.emptyNoMatch', 'No triggers match the filter.')}
              </div>
            )}
            {groups.map((group) => {
              const groupOffline = group.triggers.some((summary) => summary.offline === true)
              const collapsed = collapsedGroups.has(group.workspace)
              const statusKind = groupStatusKind(group.triggers)
              return (
                <div className={styles['group']} key={group.workspace}>
                  <button
                    type="button"
                    className={styles['groupHeader']}
                    aria-expanded={!collapsed}
                    data-testid="trigger-manager-group"
                    data-workspace={group.workspace}
                    data-collapsed={collapsed ? 'true' : 'false'}
                    onClick={() => toggleGroup(group.workspace)}
                    onMouseDown={(event) => {
                      // Keep focus on the list container so arrow keys keep working.
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
                    }}
                  >
                    {collapsed ? (
                      <ChevronRight
                        className={styles['groupChevron']}
                        size={12}
                        strokeWidth={1.75}
                      />
                    ) : (
                      <ChevronDown
                        className={styles['groupChevron']}
                        size={12}
                        strokeWidth={1.75}
                      />
                    )}
                    <span className={styles['groupName']}>{group.workspaceName}</span>
                    <span
                      className={styles['groupCount']}
                      data-testid="trigger-manager-group-count"
                    >
                      {group.triggers.length}
                    </span>
                    {groupOffline && (
                      <span className={styles['groupOffline']}>
                        {localize('trigger.manager.badge.offline', 'Offline')}
                      </span>
                    )}
                    {statusKind !== undefined && (
                      <span
                        className={cx(styles['dot'], groupStatusDotClass(statusKind))}
                        data-testid="trigger-manager-group-status"
                        data-kind={statusKind}
                        data-tooltip={
                          statusKind === 'running'
                            ? localize('trigger.manager.group.running', 'Running')
                            : localize('trigger.manager.filter.attention', 'Needs attention')
                        }
                        aria-hidden="true"
                      />
                    )}
                  </button>
                  {!collapsed &&
                    group.triggers.map((summary) => {
                      const index = indexByKey.get(summary.key)
                      if (index === undefined) return null
                      const badge = triggerStatusBadge(summary)
                      const isSelected = selected?.key === summary.key
                      const canRun = triggerCanRun(summary)
                      return (
                        <div
                          {...navigation.getRowProps(index)}
                          key={summary.key}
                          className={cx(
                            styles['row'],
                            isSelected && styles['rowSelected'],
                            summary.offline === true && styles['rowOffline'],
                          )}
                          data-testid="trigger-manager-row"
                          data-trigger-key={summary.key}
                          data-tooltip={rowTooltipText(summary)}
                        >
                          <span
                            className={cx(styles['dot'], dotClass(badge.kind))}
                            aria-hidden="true"
                          />
                          <div className={styles['rowMain']}>
                            <div className={styles['rowTitle']}>
                              <span className={styles['rowName']}>{summary.name}</span>
                              <Badge
                                tone={badge.attention ? 'accent' : 'default'}
                                className={styles['rowBadge'] ?? ''}
                              >
                                {badge.label}
                              </Badge>
                            </div>
                            <div className={styles['rowMeta']}>
                              <span>{summarizeTriggerSource(summary.source)}</span>
                              {summary.nextRunAt !== undefined && (
                                <span data-testid="trigger-manager-row-next-run">
                                  {localize('trigger.manager.nextRun', 'next {time}', {
                                    time: relativeTimeUntil(summary.nextRunAt, now),
                                  })}
                                </span>
                              )}
                              {summary.lastRunAt !== undefined && (
                                <span data-testid="trigger-manager-row-last-run">
                                  {rowLastRunText(summary)}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className={styles['rowActions']}>
                            <IconButton
                              label={localize('trigger.manager.action.runNow', 'Run now')}
                              size={20}
                              tabIndex={-1}
                              disabled={!canRun}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => void actions.runNow(summary)}
                              data-testid="trigger-manager-row-run-now"
                            >
                              <Play size={13} strokeWidth={1.75} />
                            </IconButton>
                            <IconButton
                              label={localize('trigger.manager.row.more', 'More actions')}
                              size={20}
                              tabIndex={-1}
                              aria-haspopup="menu"
                              aria-expanded={rowMenu?.summary.key === summary.key}
                              onMouseDown={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                              }}
                              onClick={(event) => {
                                const rect = event.currentTarget.getBoundingClientRect()
                                setRowMenu((current) =>
                                  current?.summary.key === summary.key
                                    ? undefined
                                    : { summary, x: rect.left, y: rect.bottom },
                                )
                              }}
                              data-testid="trigger-manager-row-more"
                            >
                              <MoreHorizontal size={13} strokeWidth={1.75} />
                            </IconButton>
                          </div>
                          <RowPauseToggle
                            summary={summary}
                            pausedAll={pausedAll}
                            actions={actions}
                          />
                        </div>
                      )
                    })}
                </div>
              )
            })}
          </div>
        </aside>

        <section className={styles['detailPane']}>
          <div className={styles['tabs']} role="tablist">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                className={cx(styles['tab'], tab === entry.id && styles['tabActive'])}
                onClick={() => switchTab(entry.id)}
                data-testid={`trigger-manager-tab-${entry.id}`}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div
            className={styles['detailBody']}
            ref={detailRef}
            data-testid="trigger-manager-detail"
          >
            {selected === undefined ? (
              <div className={styles['state']} data-testid="trigger-manager-select-prompt">
                {localize('trigger.manager.selectPrompt', 'Select a trigger to see its details.')}
              </div>
            ) : tab === 'configuration' ? (
              <TriggerConfigPanel summary={selected} />
            ) : tab === 'runs' ? (
              <TriggerRunsPanel summary={selected} />
            ) : (
              <TriggerOverviewPanel summary={selected} actions={actions} />
            )}
          </div>
        </section>
      </div>

      {filterMenu !== undefined && (
        <ListMenu
          items={FILTER_OPTIONS.map((option) => ({
            kind: 'item' as const,
            id: option.value,
            label: option.label,
            hint: filter === option.value ? '✓' : undefined,
            run: () => setFilter(option.value),
          }))}
          anchor={filterMenu}
          onClose={() => setFilterMenu(undefined)}
        />
      )}

      {rowMenu !== undefined && (
        <ListMenu
          items={[
            {
              kind: 'item',
              label: localize('trigger.manager.action.revealJson', 'Reveal in JSON'),
              run: () => void actions.revealInJson(rowMenu.summary),
            },
            {
              kind: 'item',
              label: localize('trigger.manager.action.showLog', 'View log'),
              run: () => void actions.showLog(),
            },
          ]}
          anchor={{ x: rowMenu.x, y: rowMenu.y }}
          onClose={() => setRowMenu(undefined)}
        />
      )}

      {createOpen && (
        <TriggerCreateWizard onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
      )}
    </div>
  )
}

function sameWorkspaceIdentity(a: string, b: string): boolean {
  if (a === b) return true
  const left = parseWorkspaceUri(a)
  const right = parseWorkspaceUri(b)
  return left !== undefined && right !== undefined && left.toString() === right.toString()
}

function RowPauseToggle({
  summary,
  pausedAll,
  actions,
}: {
  readonly summary: TriggerSummary
  readonly pausedAll: boolean
  readonly actions: TriggerManagerActions
}) {
  const disabled = pausedAll || summary.status === 'invalid'
  const label = disabled
    ? localize('trigger.manager.toggle.disabled', 'The trigger cannot be paused or resumed here')
    : summary.paused
      ? localize('trigger.manager.toggle.resume', 'Resume trigger "{name}"', {
          name: summary.name,
        })
      : localize('trigger.manager.toggle.pause', 'Pause trigger "{name}"', { name: summary.name })
  return (
    <Toggle
      checked={!summary.paused}
      disabled={disabled}
      aria-label={label}
      onChange={(next) => void actions.setPaused(summary, !next)}
      data-testid="trigger-manager-row-toggle"
    />
  )
}

function rowLastRunText(summary: TriggerSummary): string {
  const time = summary.lastRunAt === undefined ? '' : relativeTime(summary.lastRunAt)
  const outcome = triggerRunOutcomeLabel(summary.lastRunOutcome)
  return outcome === undefined
    ? localize('trigger.manager.lastRun', 'last run {time}', { time })
    : localize('trigger.manager.lastRunOutcome', 'last run: {outcome} · {time}', {
        outcome,
        time,
      })
}

function dotClass(kind: ReturnType<typeof triggerStatusBadge>['kind']): string {
  switch (kind) {
    case 'running':
      return styles['dotRunning'] ?? ''
    case 'needs-confirmation':
    case 'auto-paused':
    case 'offline':
      return styles['dotWarning'] ?? ''
    case 'invalid':
    case 'error':
      return styles['dotError'] ?? ''
    case 'queued':
    case 'paused':
    case 'disabled':
    case 'idle':
      return styles['dotMuted'] ?? ''
  }
}

type GroupStatusKind = 'error' | 'warning' | 'running'

/** One dot keeps a collapsed group's health visible without expanding it. */
function groupStatusKind(triggers: readonly TriggerSummary[]): GroupStatusKind | undefined {
  let warning = false
  let running = false
  for (const summary of triggers) {
    const badge = triggerStatusBadge(summary)
    if (badge.kind === 'invalid' || badge.kind === 'error') return 'error'
    if (badge.attention) warning = true
    if (badge.kind === 'running') running = true
  }
  if (warning) return 'warning'
  return running ? 'running' : undefined
}

function groupStatusDotClass(kind: GroupStatusKind): string {
  switch (kind) {
    case 'error':
      return styles['dotError'] ?? ''
    case 'warning':
      return styles['dotWarning'] ?? ''
    case 'running':
      return styles['dotRunning'] ?? ''
  }
}

function rowTooltipText(summary: TriggerSummary): string | undefined {
  if (summary.lastRunSummary !== undefined && summary.lastRunSummary.length > 0) {
    return summary.lastRunSummary
  }
  if (summary.lastError !== undefined && summary.lastError.length > 0) return summary.lastError
  return undefined
}

function triggerFilterLabel(filter: TriggerListFilter): string {
  return FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? filter
}
