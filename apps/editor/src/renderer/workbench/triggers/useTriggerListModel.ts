/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Derived view model for the trigger manager list: filtering, ordering, workspace
 *  grouping, collapsed visibility and the effective selection. Kept out of the
 *  editor shell so the list panel and the detail pane read the same snapshot.
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import type {
  TriggerListFilter,
  TriggerWorkspaceGroup,
} from '../../services/triggers/triggerPresentation.js'
import type { TriggerSummary } from '../../../shared/triggers/types.js'
import {
  groupTriggersByWorkspace,
  sortTriggersForDisplay,
  triggerMatchesListFilter,
  triggerMatchesSearch,
} from '../../services/triggers/triggerPresentation.js'

export interface TriggerListModelOptions {
  readonly summaries: readonly TriggerSummary[]
  readonly query: string
  readonly filter: TriggerListFilter
  readonly collapsedGroups: ReadonlySet<string>
  readonly selectedKey: string | undefined
}

export interface TriggerListModel {
  readonly hasSummaries: boolean
  readonly matching: readonly TriggerSummary[]
  readonly ordered: readonly TriggerSummary[]
  readonly groups: readonly TriggerWorkspaceGroup[]
  readonly visibleSummaries: readonly TriggerSummary[]
  readonly indexByKey: ReadonlyMap<string, number>
  readonly selected: TriggerSummary | undefined
}

export function useTriggerListModel({
  summaries,
  query,
  filter,
  collapsedGroups,
  selectedKey,
}: TriggerListModelOptions): TriggerListModel {
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

  return {
    hasSummaries: summaries.length > 0,
    matching,
    ordered,
    groups,
    visibleSummaries,
    indexByKey,
    selected,
  }
}
