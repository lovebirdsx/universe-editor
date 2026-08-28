/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Form-driven settings editor, VSCode style: left TOC + virtualized flat list
 *  of group headers and setting rows. Search supports `@modified`, `@id:` and
 *  tiered relevance ranking. Query and scroll position persist across tab
 *  switches and reloads (GLOBAL storage); the target tab rides the input's
 *  own serialization.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  ConfigurationRegistry,
  ConfigurationTarget,
  IConfigurationService,
  INotificationService,
  IStorageService,
  IWorkspaceService,
  Severity,
  localize,
  type IEditorInput,
} from '@universe-editor/platform'
import {
  VirtualList,
  useScrollRestore,
  type VirtualListHandle,
} from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import {
  SETTINGS_EDITOR_FOCUS_SEARCH_EVENT,
  SETTINGS_EDITOR_SWITCH_TARGET_EVENT,
} from './preferencesFocus.js'
import { SettingsEditorInput } from '../../services/editor/SettingsEditorInput.js'
import {
  buildFlatModel,
  buildTocEntries,
  estimateFlatItemSize,
  type SettingsFlatItem,
  type SettingsTocEntry,
} from '../../services/preferences/settingsFlatModel.js'
import {
  filterAndRankSettings,
  parseQuery,
  type SettingSearchEntry,
} from '../../services/preferences/settingsSearchModel.js'
import { SettingsScrollPersister } from '../../services/preferences/settingsScrollPersister.js'
import { SettingsRow } from './SettingsRow.js'
import { SettingsToc } from './SettingsToc.js'
import { useSettingsQueryState } from './useSettingsQueryState.js'
import styles from './SettingsEditor.module.css'

type EditableTarget = ConfigurationTarget.User | ConfigurationTarget.Project

function scrollStorageKey(target: EditableTarget): string {
  return target === ConfigurationTarget.Project
    ? 'settingsEditor.scroll.project'
    : 'settingsEditor.scroll.user'
}

function flatItemKey(item: SettingsFlatItem): string {
  return item.kind === 'header' ? `h:${item.id}` : `r:${item.key}`
}

export function SettingsEditor({ input }: { input: IEditorInput }) {
  const config = useService(IConfigurationService)
  const workspace = useService(IWorkspaceService)
  const notifications = useService(INotificationService)
  const storage = useService(IStorageService)

  const [activeTarget, setActiveTarget] = useState<EditableTarget>(
    () => (input as SettingsEditorInput).target ?? ConfigurationTarget.User,
  )
  const [hasWorkspace, setHasWorkspace] = useState(() => workspace.current !== null)
  const { query, setQuery } = useSettingsQueryState(storage)
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [activeTocId, setActiveTocId] = useState<string | undefined>(undefined)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<VirtualListHandle>(null)

  const scrollPersister = useMemo(() => new SettingsScrollPersister(storage), [storage])
  useEffect(() => {
    void scrollPersister.prefetch([
      scrollStorageKey(ConfigurationTarget.User),
      scrollStorageKey(ConfigurationTarget.Project),
    ])
  }, [scrollPersister])
  useScrollRestore(
    scrollStorageKey(activeTarget),
    () => listRef.current?.getScrollElement() ?? null,
    scrollPersister,
  )

  useEffect(() => {
    const focusSearch = () => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }

    focusSearch()
    document.addEventListener(SETTINGS_EDITOR_FOCUS_SEARCH_EVENT, focusSearch)
    return () => document.removeEventListener(SETTINGS_EDITOR_FOCUS_SEARCH_EVENT, focusSearch)
  }, [])

  // Track workspace open/close to enable/disable the Workspace tab.
  useEffect(() => {
    const d = workspace.onDidChangeWorkspace((w) => {
      const open = w !== null
      setHasWorkspace(open)
      // If workspace closes while Workspace tab is active, fall back to User.
      if (!open) setActiveTarget(ConfigurationTarget.User)
    })
    return () => d.dispose()
  }, [workspace])

  // Listen for external switch-target dispatches (e.g. from OpenWorkspaceSettingsAction).
  useEffect(() => {
    const handler = (e: Event) => {
      const t = (e as CustomEvent<number>).detail as EditableTarget
      if (t === ConfigurationTarget.Project && !workspace.current) return
      setActiveTarget(t)
      ;(input as SettingsEditorInput).switchTarget(t)
    }
    document.addEventListener(SETTINGS_EDITOR_SWITCH_TARGET_EVENT, handler)
    return () => document.removeEventListener(SETTINGS_EDITOR_SWITCH_TARGET_EVENT, handler)
  }, [input, workspace])

  // Re-render whenever schema registry changes or any configuration value changes.
  useEffect(() => {
    const d1 = ConfigurationRegistry.onDidRegisterConfiguration(() => bump())
    const d2 = config.onDidChangeConfiguration(() => bump())
    return () => {
      d1.dispose()
      d2.dispose()
    }
  }, [config])

  function handleSwitchTarget(t: EditableTarget): void {
    if (t === ConfigurationTarget.Project && !hasWorkspace) {
      notifications.notify({
        message: localize('settings.noWorkspace', 'Open a folder to edit workspace settings.'),
        severity: Severity.Info,
      })
      return
    }
    setActiveTarget(t)
    ;(input as SettingsEditorInput).switchTarget(t)
  }

  const nodes = ConfigurationRegistry.getConfigurationNodes()
  const parsedQuery = useMemo(() => parseQuery(query), [query])
  const hasQuery = query.trim() !== ''

  // The search/flat models are rebuilt every render on purpose: a registry walk
  // over a few hundred keys is sub-millisecond, and computing fresh values on
  // every config/registry bump keeps the data flow trivially correct. The
  // render cost that matters (row DOM) is guarded by the memoized SettingsRow.
  let ranked: ReturnType<typeof filterAndRankSettings> | undefined
  if (hasQuery) {
    const entries: SettingSearchEntry[] = []
    let order = 0
    for (const node of nodes) {
      for (const [key, schema] of Object.entries(node.properties)) {
        entries.push({
          key,
          description: schema.description ?? '',
          order: order++,
          isModified: config.getValueOriginForTarget(key, activeTarget) === activeTarget,
        })
      }
    }
    ranked = filterAndRankSettings(entries, parsedQuery)
  }

  const model = buildFlatModel(nodes, ranked)
  const tocEntries = buildTocEntries(model)
  const groupTitles = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of nodes) map.set(node.id, node.title ?? node.id)
    return map
  }, [nodes])
  const totalRows = model.items.reduce((acc, item) => acc + (item.kind === 'row' ? 1 : 0), 0)

  // Keep the TOC highlight on the group whose header scrolled past the top.
  useEffect(() => {
    const el = listRef.current?.getScrollElement()
    if (!el || model.headerIndexes.length === 0) {
      setActiveTocId(undefined)
      return
    }
    const update = () => {
      const top = el.scrollTop + 40
      let active: string | undefined
      for (let i = 0; i < model.headerIndexes.length; i++) {
        if (model.headerOffsets[i]! <= top) {
          const header = model.items[model.headerIndexes[i]!]
          if (header?.kind === 'header') active = header.id
        } else {
          break
        }
      }
      setActiveTocId(active)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  }, [model])

  const handleTocNavigate = useCallback((entry: SettingsTocEntry) => {
    setActiveTocId(entry.id)
    listRef.current?.scrollToIndex(entry.itemIndex, { align: 'start' })
  }, [])

  const handleUpdate = useCallback(
    (key: string, value: unknown) => {
      config.update(key, value, activeTarget)
    },
    [config, activeTarget],
  )

  const renderItem = useCallback(
    (item: SettingsFlatItem) => {
      if (item.kind === 'header') {
        return (
          <div
            key={flatItemKey(item)}
            className={styles['sectionHeader']}
            data-testid={`settings-group-${item.id}`}
          >
            <span className={styles['sectionTitle']}>{item.title}</span>
            <span className={styles['sectionCount']}>{item.count}</span>
          </div>
        )
      }
      const origin = config.getValueOriginForTarget(item.key, activeTarget)
      const otherTarget =
        activeTarget === ConfigurationTarget.User
          ? ConfigurationTarget.Project
          : ConfigurationTarget.User
      const rawOther = hasWorkspace
        ? config.getValueOriginForTarget(item.key, otherTarget)
        : undefined
      const otherOrigin =
        rawOther !== undefined && rawOther !== ConfigurationTarget.Default ? rawOther : undefined
      return (
        <SettingsRow
          key={flatItemKey(item)}
          configKey={item.key}
          schema={item.schema}
          groupTitle={groupTitles.get(item.groupId) ?? item.groupId}
          value={config.getValueForTarget(item.key, activeTarget)}
          defaultValue={config.getValueForTarget(item.key, ConfigurationTarget.Default)}
          origin={origin}
          activeTarget={activeTarget}
          otherOrigin={otherOrigin}
          onUpdate={handleUpdate}
        />
      )
    },
    [config, activeTarget, hasWorkspace, groupTitles, handleUpdate],
  )

  return (
    <div className={styles['root']}>
      <div className={styles['header']}>
        <div className={styles['tabs']}>
          <button
            className={`${styles['tab']} ${activeTarget === ConfigurationTarget.User ? styles['tabActive'] : ''}`}
            aria-selected={activeTarget === ConfigurationTarget.User}
            onClick={() => handleSwitchTarget(ConfigurationTarget.User)}
          >
            {localize('settings.tab.user', 'User')}
          </button>
          <button
            className={`${styles['tab']} ${!hasWorkspace ? styles['tabDisabled'] : ''} ${activeTarget === ConfigurationTarget.Project ? styles['tabActive'] : ''}`}
            aria-selected={activeTarget === ConfigurationTarget.Project}
            onClick={() => handleSwitchTarget(ConfigurationTarget.Project)}
          >
            {localize('settings.tab.workspace', 'Workspace')}
          </button>
        </div>
        <div className={styles['searchRow']}>
          <input
            ref={searchInputRef}
            className={styles['search']}
            type="search"
            placeholder={localize('settings.search.placeholder', 'Search settings ({count})', {
              count: totalRows,
            })}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {hasQuery ? (
            <span className={styles['countBadge']} data-testid="settings-count">
              {localize('settings.count', '{count} Settings Found', { count: totalRows })}
            </span>
          ) : null}
        </div>
      </div>
      <div className={styles['body']}>
        {model.items.length === 0 ? (
          <div className={styles['empty']}>
            <div>{localize('settings.empty', 'No matching settings.')}</div>
            {hasQuery ? (
              <button className={styles['clearSearch']} onClick={() => setQuery('')}>
                {localize('settings.clearSearch', 'Clear Search')}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <SettingsToc
              entries={tocEntries}
              activeId={activeTocId}
              onNavigate={handleTocNavigate}
            />
            <VirtualList
              ref={listRef}
              className={styles['list']}
              items={model.items}
              estimateSize={(index) => estimateFlatItemSize(model.items[index]!)}
              getItemKey={(index) => flatItemKey(model.items[index]!)}
              measureDynamically
              overscan={8}
              renderItem={renderItem}
            />
          </>
        )}
      </div>
    </div>
  )
}
