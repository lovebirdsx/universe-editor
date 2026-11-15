/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Trigger manager list pane: toolbar, grouped rows, empty/loading states and the
 *  filter / row context menus. All data is derived in `useTriggerListModel`; this
 *  component only owns transient menu state and keyboard navigation.
 *--------------------------------------------------------------------------------------------*/

import { useState, type RefObject } from 'react'
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
import { localize } from '@universe-editor/platform'
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
import {
  relativeTimeUntil,
  summarizeTriggerSource,
  triggerCanRun,
  triggerStatusBadge,
  type TriggerListFilter,
} from '../../services/triggers/triggerPresentation.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { relativeTime } from '../../relativeTime.js'
import { triggerRunOutcomeLabel } from '../agents/automationLabels.js'
import styles from './TriggerListPanel.module.css'
import type { TriggerManagerActions } from './useTriggerActions.js'
import type { TriggerListModel } from './useTriggerListModel.js'

const FILTER_OPTIONS: readonly { readonly value: TriggerListFilter; readonly label: string }[] = [
  { value: 'all', label: localize('trigger.manager.filter.all', 'All triggers') },
  { value: 'active', label: localize('trigger.manager.filter.active', 'Active') },
  { value: 'attention', label: localize('trigger.manager.filter.attention', 'Needs attention') },
  { value: 'paused', label: localize('trigger.manager.filter.paused', 'Paused') },
]

export interface TriggerListPanelProps {
  readonly model: TriggerListModel
  readonly loaded: boolean
  readonly loadError: string | undefined
  readonly now: number
  readonly query: string
  readonly setQuery: (value: string) => void
  readonly filter: TriggerListFilter
  readonly setFilter: (filter: TriggerListFilter) => void
  readonly collapsedGroups: ReadonlySet<string>
  readonly toggleGroup: (workspace: string) => void
  readonly selectKey: (key: string) => void
  readonly listRef: RefObject<HTMLDivElement | null>
  readonly pausedAll: boolean
  readonly rescanning: boolean
  readonly onRescan: () => void
  readonly onResumeAll: () => void
  readonly onPauseAll: () => void
  readonly onCreate: () => void
  readonly actions: TriggerManagerActions
}

export function TriggerListPanel({
  model,
  loaded,
  loadError,
  now,
  query,
  setQuery,
  filter,
  setFilter,
  collapsedGroups,
  toggleGroup,
  selectKey,
  listRef,
  pausedAll,
  rescanning,
  onRescan,
  onResumeAll,
  onPauseAll,
  onCreate,
  actions,
}: TriggerListPanelProps) {
  const [filterMenu, setFilterMenu] = useState<
    { readonly x: number; readonly y: number } | undefined
  >(undefined)
  const [rowMenu, setRowMenu] = useState<
    { readonly summary: TriggerSummary; readonly x: number; readonly y: number } | undefined
  >(undefined)

  const selectedIndex =
    model.selected === undefined ? -1 : model.visibleSummaries.indexOf(model.selected)
  const navigation = useFlatListNavigation({
    count: model.visibleSummaries.length,
    focusedIndex: selectedIndex,
    onFocusChange: (index) => {
      const summary = model.visibleSummaries[index]
      if (summary !== undefined) selectKey(summary.key)
    },
    getItemKey: (index) => model.visibleSummaries[index]?.key ?? String(index),
    getContainer: () => listRef.current,
    onActivate: (index) => {
      const summary = model.visibleSummaries[index]
      if (summary !== undefined) selectKey(summary.key)
    },
    ariaLabel: localize('trigger.manager.list.label', 'Triggers'),
    focusSelectsFirst: false,
  })

  return (
    <>
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
            onClick={onCreate}
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
            onClick={pausedAll ? onResumeAll : onPauseAll}
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
          {...(model.hasSummaries ? navigation.containerProps : {})}
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
          {loaded && loadError === undefined && !model.hasSummaries && (
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
                onClick={onRescan}
                data-testid="trigger-manager-rescan"
              >
                <RefreshCw size={14} strokeWidth={1.75} />
                {localize('trigger.manager.rescan', 'Rescan')}
              </Button>
            </div>
          )}
          {loaded && model.hasSummaries && model.matching.length === 0 && (
            <div className={styles['state']} data-testid="trigger-manager-empty-match">
              {localize('trigger.manager.emptyNoMatch', 'No triggers match the filter.')}
            </div>
          )}
          {model.groups.map((group) => {
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
                    <ChevronRight className={styles['groupChevron']} size={12} strokeWidth={1.75} />
                  ) : (
                    <ChevronDown className={styles['groupChevron']} size={12} strokeWidth={1.75} />
                  )}
                  <span className={styles['groupName']}>{group.workspaceName}</span>
                  <span className={styles['groupCount']} data-testid="trigger-manager-group-count">
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
                    const index = model.indexByKey.get(summary.key)
                    if (index === undefined) return null
                    const badge = triggerStatusBadge(summary)
                    const isSelected = model.selected?.key === summary.key
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
                        <RowPauseToggle summary={summary} pausedAll={pausedAll} actions={actions} />
                      </div>
                    )
                  })}
              </div>
            )
          })}
        </div>
      </aside>

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
    </>
  )
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
