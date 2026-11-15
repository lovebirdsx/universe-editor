/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useTriggerManagerViewState — persists the manager's view state (search, selected
 *  trigger, active tab and scroll positions) through IStorageService GLOBAL scope, so
 *  reopening the singleton tab lands where the user left off. A pending selection
 *  carried by the editor input (command / quick pick) outranks the stored one, and the
 *  first async restore never overwrites a value the user changed while it was in flight.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { IStorageService, StorageScope } from '@universe-editor/platform'
import { requestOwnerFrame } from '@universe-editor/workbench-ui'
import {
  isTriggerListFilter,
  type TriggerListFilter,
} from '../../services/triggers/triggerPresentation.js'
import type { TriggerManagerEditorInput } from '../../services/triggers/triggerManagerEditorInput.js'
import { useService } from '../useService.js'

export const TRIGGER_TABS = ['overview', 'configuration', 'runs'] as const
export type TriggerTab = (typeof TRIGGER_TABS)[number]

export function isTriggerTab(value: unknown): value is TriggerTab {
  return typeof value === 'string' && (TRIGGER_TABS as readonly string[]).includes(value)
}

export const TriggerManagerViewKeys = {
  query: 'triggerManager.view.query',
  filter: 'triggerManager.view.filter',
  collapsedGroups: 'triggerManager.view.collapsedGroups',
  selectedKey: 'triggerManager.view.selectedKey',
  tab: 'triggerManager.view.tab',
  listScrollTop: 'triggerManager.view.listScrollTop',
  detailScrollTop: (tab: TriggerTab): string => `triggerManager.view.detailScroll.${tab}`,
} as const

const WRITE_DEBOUNCE_MS = 200

export interface TriggerManagerViewStateOptions {
  readonly input: TriggerManagerEditorInput | undefined
  readonly listRef: RefObject<HTMLDivElement | null>
  readonly detailRef: RefObject<HTMLDivElement | null>
  /** The trigger list finished loading and its rows are rendered. */
  readonly listReady: boolean
  /** Keys of the listed summaries; used to drop a stored selection that no longer exists. */
  readonly selectionKeys: ReadonlySet<string>
}

export interface TriggerManagerViewState {
  readonly query: string
  readonly setQuery: (value: string) => void
  readonly filter: TriggerListFilter
  readonly setFilter: (filter: TriggerListFilter) => void
  readonly collapsedGroups: ReadonlySet<string>
  readonly toggleGroup: (workspace: string) => void
  readonly selectedKey: string | undefined
  /** Select a trigger (click / keyboard / external reveal); resets the detail scroll. */
  readonly selectKey: (key: string) => void
  readonly tab: TriggerTab
  readonly switchTab: (tab: TriggerTab) => void
}

interface DetailScrollPosition {
  readonly tab: TriggerTab
  readonly top: number
}

export function useTriggerManagerViewState({
  input,
  listRef,
  detailRef,
  listReady,
  selectionKeys,
}: TriggerManagerViewStateOptions): TriggerManagerViewState {
  const storage = useService(IStorageService)
  const [query, setQueryState] = useState('')
  const [filter, setFilterState] = useState<TriggerListFilter>('all')
  const [collapsedGroups, setCollapsedGroupsState] = useState<ReadonlySet<string>>(() => new Set())
  const [selectedKey, setSelectedKeyState] = useState<string | undefined>(undefined)
  const [tab, setTabState] = useState<TriggerTab>('overview')
  const [restoreDone, setRestoreDone] = useState(false)

  // A value the user changed while the async restore was in flight must win over it.
  const queryTouched = useRef(false)
  const filterTouched = useRef(false)
  const collapsedGroupsTouched = useRef(false)
  const selectionTouched = useRef(false)
  const tabTouched = useRef(false)
  // A failed read leaves the stored values alone instead of rewriting defaults over them.
  const restoreOk = useRef(false)

  const tabRef = useRef<TriggerTab>('overview')
  tabRef.current = tab
  const collapsedGroupsRef = useRef<ReadonlySet<string>>(collapsedGroups)
  collapsedGroupsRef.current = collapsedGroups
  const selectedKeyRef = useRef<string | undefined>(undefined)
  selectedKeyRef.current = selectedKey
  const queryRef = useRef('')
  queryRef.current = query

  const detailPositions = useRef<Partial<Record<TriggerTab, number>>>({})
  const detailRestoreTarget = useRef<DetailScrollPosition | undefined>(undefined)
  const pendingDetailWrite = useRef<DetailScrollPosition | undefined>(undefined)
  const listScrollLatest = useRef<number | undefined>(undefined)
  const listScrollTarget = useRef<number | undefined>(undefined)

  const listWriteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const detailWriteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queryWriteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const writeListScroll = useCallback(() => {
    if (listWriteTimer.current !== undefined) {
      clearTimeout(listWriteTimer.current)
      listWriteTimer.current = undefined
    }
    const value = listScrollLatest.current
    listScrollLatest.current = undefined
    if (value !== undefined) {
      void storage.set(TriggerManagerViewKeys.listScrollTop, value, StorageScope.GLOBAL)
    }
  }, [storage])

  const scheduleListScrollWrite = useCallback(() => {
    if (listWriteTimer.current !== undefined) clearTimeout(listWriteTimer.current)
    listWriteTimer.current = setTimeout(writeListScroll, WRITE_DEBOUNCE_MS)
  }, [writeListScroll])

  const writeDetailScroll = useCallback(() => {
    if (detailWriteTimer.current !== undefined) {
      clearTimeout(detailWriteTimer.current)
      detailWriteTimer.current = undefined
    }
    const pending = pendingDetailWrite.current
    pendingDetailWrite.current = undefined
    if (pending !== undefined) {
      void storage.set(
        TriggerManagerViewKeys.detailScrollTop(pending.tab),
        pending.top,
        StorageScope.GLOBAL,
      )
    }
  }, [storage])

  const scheduleDetailScrollWrite = useCallback(() => {
    if (detailWriteTimer.current !== undefined) clearTimeout(detailWriteTimer.current)
    detailWriteTimer.current = setTimeout(writeDetailScroll, WRITE_DEBOUNCE_MS)
  }, [writeDetailScroll])

  const setQuery = useCallback((value: string) => {
    queryTouched.current = true
    setQueryState(value)
  }, [])

  const setFilter = useCallback(
    (next: TriggerListFilter) => {
      filterTouched.current = true
      setFilterState(next)
      if (next === 'all') {
        void storage.remove(TriggerManagerViewKeys.filter, StorageScope.GLOBAL)
      } else {
        void storage.set(TriggerManagerViewKeys.filter, next, StorageScope.GLOBAL)
      }
    },
    [storage],
  )

  const toggleGroup = useCallback(
    (workspace: string) => {
      collapsedGroupsTouched.current = true
      const next = new Set(collapsedGroupsRef.current)
      if (next.has(workspace)) next.delete(workspace)
      else next.add(workspace)
      collapsedGroupsRef.current = next
      setCollapsedGroupsState(next)
      if (next.size === 0) {
        void storage.remove(TriggerManagerViewKeys.collapsedGroups, StorageScope.GLOBAL)
      } else {
        void storage.set(TriggerManagerViewKeys.collapsedGroups, [...next], StorageScope.GLOBAL)
      }
    },
    [storage],
  )

  const selectKey = useCallback(
    (key: string) => {
      selectionTouched.current = true
      if (key === selectedKeyRef.current) return
      setSelectedKeyState(key)

      // A new trigger always starts its detail pane at the top; the pane content is
      // replaced in place, so the browser would otherwise keep the old offset.
      detailRestoreTarget.current = undefined
      const element = detailRef.current
      if (element === null) return
      element.scrollTop = 0
      const at = tabRef.current
      detailPositions.current[at] = 0
      pendingDetailWrite.current = { tab: at, top: 0 }
      scheduleDetailScrollWrite()
    },
    [detailRef, scheduleDetailScrollWrite],
  )

  const switchTab = useCallback(
    (next: TriggerTab) => {
      if (next === tab) return
      tabTouched.current = true

      // Flush the old tab's live position before the pane swaps its content.
      const element = detailRef.current
      const previous = tabRef.current
      if (element !== null) {
        detailPositions.current[previous] = element.scrollTop
        pendingDetailWrite.current = { tab: previous, top: element.scrollTop }
      }
      writeDetailScroll()
      detailRestoreTarget.current = { tab: next, top: detailPositions.current[next] ?? 0 }
      setTabState(next)
    },
    [detailRef, tab, writeDetailScroll],
  )

  // Restore once per mount. The pending selection is consumed here (the only place):
  // it is a one-shot reveal from the command / quick pick, not persisted state.
  useEffect(() => {
    let active = true

    const pending = input?.consumePendingSelection()
    if (pending !== undefined) {
      selectionTouched.current = true
      setSelectedKeyState(pending)
    }
    const subscription = input?.onDidChangeSelection((key) => {
      input.consumePendingSelection()
      selectKey(key)
    })

    void Promise.all([
      storage.get<string>(TriggerManagerViewKeys.query, StorageScope.GLOBAL),
      storage.get<string>(TriggerManagerViewKeys.selectedKey, StorageScope.GLOBAL),
      storage.get<unknown>(TriggerManagerViewKeys.tab, StorageScope.GLOBAL),
      storage.get<unknown>(TriggerManagerViewKeys.filter, StorageScope.GLOBAL),
      storage.get<unknown>(TriggerManagerViewKeys.collapsedGroups, StorageScope.GLOBAL),
      storage.get<number>(TriggerManagerViewKeys.listScrollTop, StorageScope.GLOBAL),
      ...TRIGGER_TABS.map((entry) =>
        storage.get<number>(TriggerManagerViewKeys.detailScrollTop(entry), StorageScope.GLOBAL),
      ),
    ]).then(
      ([storedQuery, storedKey, storedTab, storedFilter, storedGroups, storedListTop, ...tops]) => {
        if (!active) return
        if (!queryTouched.current && typeof storedQuery === 'string') setQueryState(storedQuery)
        if (!selectionTouched.current && typeof storedKey === 'string' && storedKey.length > 0) {
          setSelectedKeyState(storedKey)
        }
        if (!tabTouched.current && isTriggerTab(storedTab)) setTabState(storedTab)
        if (!filterTouched.current && isTriggerListFilter(storedFilter)) {
          setFilterState(storedFilter)
        }
        const restoredGroups = parseCollapsedGroups(storedGroups)
        if (!collapsedGroupsTouched.current && restoredGroups !== undefined) {
          collapsedGroupsRef.current = restoredGroups
          setCollapsedGroupsState(restoredGroups)
        }
        if (typeof storedListTop === 'number' && storedListTop > 0) {
          listScrollTarget.current = storedListTop
        }
        TRIGGER_TABS.forEach((entry, index) => {
          const top = tops[index]
          if (typeof top === 'number' && top > 0) detailPositions.current[entry] = top
        })
        restoreOk.current = true
        setRestoreDone(true)
      },
      () => {
        // Leave the stored values untouched; the next user edit still persists.
        if (active) setRestoreDone(true)
      },
    )

    return () => {
      active = false
      subscription?.dispose()
    }
  }, [input, selectKey, storage])

  useEffect(() => {
    if (!queryTouched.current && !(restoreDone && restoreOk.current)) return
    if (queryWriteTimer.current !== undefined) clearTimeout(queryWriteTimer.current)
    queryWriteTimer.current = setTimeout(() => {
      queryWriteTimer.current = undefined
      if (query.length === 0) {
        void storage.remove(TriggerManagerViewKeys.query, StorageScope.GLOBAL)
      } else {
        void storage.set(TriggerManagerViewKeys.query, query, StorageScope.GLOBAL)
      }
    }, WRITE_DEBOUNCE_MS)
  }, [query, restoreDone, storage])

  // Flush a pending debounced search term when the tab closes within the debounce window.
  useEffect(() => {
    return () => {
      if (queryWriteTimer.current !== undefined) {
        clearTimeout(queryWriteTimer.current)
        queryWriteTimer.current = undefined
      }
      if (!queryTouched.current && !restoreOk.current) return
      const value = queryRef.current
      if (value.length === 0) {
        void storage.remove(TriggerManagerViewKeys.query, StorageScope.GLOBAL)
      } else {
        void storage.set(TriggerManagerViewKeys.query, value, StorageScope.GLOBAL)
      }
    }
  }, [storage])

  useEffect(() => {
    if (!selectionTouched.current && !(restoreDone && restoreOk.current)) return
    if (selectedKey === undefined) return
    void storage.set(TriggerManagerViewKeys.selectedKey, selectedKey, StorageScope.GLOBAL)
  }, [selectedKey, restoreDone, storage])

  useEffect(() => {
    if (!tabTouched.current && !(restoreDone && restoreOk.current)) return
    void storage.set(TriggerManagerViewKeys.tab, tab, StorageScope.GLOBAL)
  }, [tab, restoreDone, storage])

  // Drop a restored selection whose trigger disappeared from the list. Only once the
  // list actually has rows: an empty/failed load must not wipe the stored choice.
  useEffect(() => {
    if (!restoreDone || !restoreOk.current || !listReady) return
    if (selectionTouched.current || selectedKey === undefined) return
    if (selectionKeys.size === 0 || selectionKeys.has(selectedKey)) return
    setSelectedKeyState(undefined)
    void storage.remove(TriggerManagerViewKeys.selectedKey, StorageScope.GLOBAL)
  }, [listReady, restoreDone, selectedKey, selectionKeys, storage])

  useEffect(() => {
    const listElement = listRef.current
    const detailElement = detailRef.current

    const onListScroll = (): void => {
      if (listElement === null) return
      listScrollLatest.current = listElement.scrollTop
      scheduleListScrollWrite()
    }
    const onDetailScroll = (): void => {
      if (detailElement === null) return
      const at = tabRef.current
      detailPositions.current[at] = detailElement.scrollTop
      pendingDetailWrite.current = { tab: at, top: detailElement.scrollTop }
      scheduleDetailScrollWrite()
    }

    listElement?.addEventListener('scroll', onListScroll)
    detailElement?.addEventListener('scroll', onDetailScroll)
    return () => {
      listElement?.removeEventListener('scroll', onListScroll)
      detailElement?.removeEventListener('scroll', onDetailScroll)
      writeListScroll()
      writeDetailScroll()
    }
  }, [
    detailRef,
    listRef,
    scheduleDetailScrollWrite,
    scheduleListScrollWrite,
    writeDetailScroll,
    writeListScroll,
  ])

  useEffect(() => {
    if (!restoreDone || !listReady) return
    const target = listScrollTarget.current
    listScrollTarget.current = undefined
    if (target === undefined) return
    const element = listRef.current
    if (element === null) return
    let cancelled = false
    requestOwnerFrame(element, () => {
      if (!cancelled) element.scrollTop = target
    })
    return () => {
      cancelled = true
    }
  }, [listReady, listRef, restoreDone])

  useEffect(() => {
    if (!restoreDone || !listReady) return
    const target = detailRestoreTarget.current
    detailRestoreTarget.current = undefined
    const top =
      target !== undefined && target.tab === tab ? target.top : (detailPositions.current[tab] ?? 0)
    const element = detailRef.current
    if (element === null) return
    let cancelled = false
    requestOwnerFrame(element, () => {
      if (!cancelled) element.scrollTop = top
    })
    return () => {
      cancelled = true
    }
  }, [detailRef, listReady, restoreDone, tab])

  return {
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
  }
}

function parseCollapsedGroups(value: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(value)) return undefined
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'))
}
