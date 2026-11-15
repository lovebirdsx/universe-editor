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
import { localize, type IEditorInput, type URI } from '@universe-editor/platform'
import { Button, cx } from '@universe-editor/workbench-ui'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { triggerNeedsConfirmation } from '../../services/triggers/triggerPresentation.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import { TriggerManagerEditorInput } from '../../services/triggers/triggerManagerEditorInput.js'
import { useService } from '../useService.js'
import { errorText } from './triggerFormParts.js'
import styles from './TriggerManagerEditor.module.css'
import { TriggerConfigPanel, type TriggerConfigDraftState } from './TriggerConfigPanel.js'
import { TriggerCreateWizard } from './TriggerCreateWizard.js'
import { TriggerListPanel } from './TriggerListPanel.js'
import { TriggerOverviewPanel } from './TriggerOverviewPanel.js'
import { TriggerRunsPanel } from './TriggerRunsPanel.js'
import { useTriggerActions } from './useTriggerActions.js'
import { useTriggerListModel } from './useTriggerListModel.js'
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
  // Configuration drafts are keyed by composite trigger key and live here, so
  // switching tabs or triggers (which unmounts the panel) never loses them.
  const [draftStates, setDraftStates] = useState<ReadonlyMap<string, TriggerConfigDraftState>>(
    () => new Map(),
  )
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

  const listModel = useTriggerListModel({
    summaries,
    query,
    filter,
    collapsedGroups,
    selectedKey,
  })
  const selected = listModel.selected

  // Drop drafts whose trigger disappeared (deleted / workspace removed). An empty
  // list during the initial load must not wipe anything: the map starts empty.
  useEffect(() => {
    setDraftStates((current) => {
      if (current.size === 0) return current
      const keys = new Set(summaries.map((entry) => entry.key))
      let changed = false
      const next = new Map<string, TriggerConfigDraftState>()
      for (const [key, state] of current) {
        if (keys.has(key)) next.set(key, state)
        else changed = true
      }
      return changed ? next : current
    })
  }, [summaries])

  const selectedDraftKey = selected?.key
  const handleDraftStateChange = useCallback(
    (state: TriggerConfigDraftState | undefined) => {
      if (selectedDraftKey === undefined) return
      setDraftStates((current) => {
        const existing = current.get(selectedDraftKey)
        if (state === undefined) {
          if (existing === undefined) return current
          const next = new Map(current)
          next.delete(selectedDraftKey)
          return next
        }
        const next = new Map(current)
        next.set(selectedDraftKey, state)
        return next
      })
    },
    [selectedDraftKey],
  )

  const dirtyDraftCount = useMemo(
    () => [...draftStates.values()].filter((state) => state.dirty).length,
    [draftStates],
  )
  const dirtyDraftCountRef = useRef(0)
  dirtyDraftCountRef.current = dirtyDraftCount

  // Closing the singleton tab would discard parked drafts; closeEditorWithConfirm
  // and auxiliary-window close both consult this hook on the input.
  useEffect(() => {
    if (managerInput === undefined) return
    managerInput.confirmClose = async (dialogService) => {
      if (dirtyDraftCountRef.current === 0) return true
      const { confirmed } = await dialogService.confirm({
        type: 'warning',
        message: localize(
          'trigger.manager.closeDirty.message',
          'You have {count} unsaved trigger configuration draft(s).',
          { count: dirtyDraftCountRef.current },
        ),
        detail: localize(
          'trigger.manager.closeDirty.detail',
          'Closing the trigger manager will discard them.',
        ),
        primaryButton: localize('trigger.manager.closeDirty.discard', 'Discard and close'),
      })
      return confirmed
    }
    return () => {
      delete managerInput.confirmClose
    }
  }, [managerInput])

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
        <TriggerListPanel
          model={listModel}
          loaded={loaded}
          loadError={loadError}
          now={now}
          query={query}
          setQuery={setQuery}
          filter={filter}
          setFilter={setFilter}
          collapsedGroups={collapsedGroups}
          toggleGroup={toggleGroup}
          selectKey={selectKey}
          listRef={listRef}
          pausedAll={pausedAll}
          rescanning={rescanning}
          onRescan={() => void runRescan()}
          onResumeAll={resumeAll}
          onPauseAll={pauseAll}
          onCreate={openCreateWizard}
          actions={actions}
        />

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
              <TriggerConfigPanel
                key={selected.key}
                summary={selected}
                draftState={draftStates.get(selected.key)}
                onDraftStateChange={handleDraftStateChange}
              />
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
