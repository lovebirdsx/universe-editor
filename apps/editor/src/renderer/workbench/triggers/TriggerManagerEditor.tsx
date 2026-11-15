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
import { FileJson, Pause, Play, Plus, RefreshCw, ScrollText } from 'lucide-react'
import { localize, type IEditorInput, type URI } from '@universe-editor/platform'
import {
  Badge,
  Button,
  IconButton,
  Input,
  Toggle,
  cx,
  useFlatListNavigation,
} from '@universe-editor/workbench-ui'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import {
  groupTriggersByWorkspace,
  relativeTimeUntil,
  summarizeTriggerSource,
  triggerNeedsConfirmation,
  triggerStatusBadge,
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
  const [pendingCreated, setPendingCreated] = useState<
    { readonly workspace: string; readonly id: string } | undefined
  >(undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const selectionKeys = useMemo(() => new Set(summaries.map((entry) => entry.key)), [summaries])
  const { query, setQuery, selectedKey, selectKey, tab, switchTab } = useTriggerManagerViewState({
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return summaries
    return summaries.filter(
      (summary) =>
        summary.name.toLowerCase().includes(needle) ||
        summary.id.toLowerCase().includes(needle) ||
        summary.workspaceName.toLowerCase().includes(needle),
    )
  }, [summaries, query])

  const selected =
    (selectedKey !== undefined
      ? summaries.find((summary) => summary.key === selectedKey)
      : undefined) ??
    filtered[0] ??
    summaries[0]

  const selectedIndex = selected === undefined ? -1 : filtered.indexOf(selected)
  const navigation = useFlatListNavigation({
    count: filtered.length,
    focusedIndex: selectedIndex,
    onFocusChange: (index) => {
      const summary = filtered[index]
      if (summary !== undefined) selectKey(summary.key)
    },
    getItemKey: (index) => filtered[index]?.key ?? String(index),
    getContainer: () => listRef.current,
    onActivate: (index) => {
      const summary = filtered[index]
      if (summary !== undefined) selectKey(summary.key)
    },
    ariaLabel: localize('trigger.manager.list.label', 'Triggers'),
    focusSelectsFirst: false,
  })

  const groups = useMemo(() => groupTriggersByWorkspace(filtered), [filtered])
  const indexByKey = useMemo(() => {
    const index = new Map<string, number>()
    filtered.forEach((summary, position) => index.set(summary.key, position))
    return index
  }, [filtered])

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
            {loaded && summaries.length > 0 && filtered.length === 0 && (
              <div className={styles['state']} data-testid="trigger-manager-empty-match">
                {localize('trigger.manager.emptyNoMatch', 'No triggers match the filter.')}
              </div>
            )}
            {groups.map((group) => {
              const groupOffline = group.triggers.some((summary) => summary.offline === true)
              return (
                <div className={styles['group']} key={group.workspace}>
                  <div
                    className={styles['groupHeader']}
                    data-testid="trigger-manager-group"
                    data-workspace={group.workspace}
                  >
                    <span className={styles['groupName']}>{group.workspaceName}</span>
                    {groupOffline && (
                      <span className={styles['groupOffline']}>
                        {localize('trigger.manager.badge.offline', 'Offline')}
                      </span>
                    )}
                  </div>
                  {group.triggers.map((summary) => {
                    const index = indexByKey.get(summary.key)
                    if (index === undefined) return null
                    const badge = triggerStatusBadge(summary)
                    const isSelected = selected?.key === summary.key
                    const hasRunSummary =
                      summary.lastRunSummary !== undefined && summary.lastRunSummary.length > 0
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
                        data-tooltip={hasRunSummary ? undefined : summary.lastError}
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
                          {summary.lastRunSummary !== undefined &&
                            summary.lastRunSummary.length > 0 && (
                              <div
                                className={styles['rowSummary']}
                                data-tooltip={summary.lastRunSummary}
                              >
                                {summary.lastRunSummary}
                              </div>
                            )}
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
