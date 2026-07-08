/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionsView — the Extensions viewlet. A search box drives a marketplace
 *  query (debounced); results show under MARKETPLACE while the installed set
 *  shows under INSTALLED. With no marketplace configured (GALLERY_URL empty), the
 *  search box + MARKETPLACE group hide and only INSTALLED remains, alongside the
 *  "install from VSIX" command. Clicking a row opens its detail editor. All state
 *  is read through IExtensionsWorkbenchService — this component owns no wire logic.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Package } from 'lucide-react'
import { IEditorService, localize } from '@universe-editor/platform'
import { Button, Input, Spinner, cx } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import {
  IExtensionsWorkbenchService,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import { ExtensionEditorInput } from '../../services/editor/ExtensionEditorInput.js'
import styles from './ExtensionsView.module.css'

const SEARCH_DEBOUNCE_MS = 300

/** Re-render whenever the workbench facade fires a change. */
function useWorkbenchTick(service: IExtensionsWorkbenchService): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const sub = service.onDidChange(() => setTick((t) => t + 1))
    return () => sub.dispose()
  }, [service])
  return tick
}

export function ExtensionsView() {
  const service = useService(IExtensionsWorkbenchService)
  const editorService = useService(IEditorService)
  useWorkbenchTick(service)

  const [marketplaceEnabled, setMarketplaceEnabled] = useState(false)
  const [query, setQuery] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    void service.isMarketplaceEnabled().then(setMarketplaceEnabled)
    void service.refreshInstalled()
  }, [service])

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => void service.search(value), SEARCH_DEBOUNCE_MS)
    },
    [service],
  )

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    [],
  )

  const openDetail = useCallback(
    (entry: IExtensionEntry) => {
      void editorService.openEditor(new ExtensionEditorInput(entry.id))
    },
    [editorService],
  )

  const installed = service.getInstalled()
  const searching = service.searching
  const results = service.getSearchResults()
  const showMarketplace = marketplaceEnabled && query.trim().length > 0

  return (
    <div className={styles.container} data-testid="extensions-view">
      {marketplaceEnabled && (
        <div className={styles.searchRow}>
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={localize('extensions.search.placeholder', 'Search Extensions Marketplace')}
            aria-label={localize('extensions.search.label', 'Search Extensions')}
          />
        </div>
      )}

      <div className={styles.scroll}>
        {showMarketplace ? (
          <Section
            title={localize('extensions.group.marketplace', 'Marketplace')}
            loading={searching}
          >
            {results.map((entry) => (
              <ExtensionRow
                key={entry.id}
                entry={entry}
                onOpen={openDetail}
                onInstall={() => void service.install(entry)}
                onUninstall={() => void service.uninstall(entry)}
              />
            ))}
            {!searching && results.length === 0 && (
              <div className={styles.empty}>
                {localize('extensions.noResults', 'No extensions found')}
              </div>
            )}
          </Section>
        ) : (
          <Section title={localize('extensions.group.installed', 'Installed')}>
            {installed.map((entry) => (
              <ExtensionRow
                key={entry.id}
                entry={entry}
                onOpen={openDetail}
                onInstall={() => void service.install(entry)}
                onUninstall={() => void service.uninstall(entry)}
              />
            ))}
            {installed.length === 0 && (
              <div className={styles.empty}>
                {localize('extensions.noneInstalled', 'No extensions installed')}
              </div>
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  loading,
  children,
}: {
  title: string
  loading?: boolean
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className={styles.section}>
      <button className={styles.sectionHeader} onClick={() => setCollapsed((c) => !c)}>
        {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        <span className={styles.sectionTitle}>{title}</span>
        {loading && <Spinner size={12} />}
      </button>
      {!collapsed && <div className={styles.sectionBody}>{children}</div>}
    </div>
  )
}

function ExtensionRow({
  entry,
  onOpen,
  onInstall,
  onUninstall,
}: {
  entry: IExtensionEntry
  onOpen: (entry: IExtensionEntry) => void
  onInstall: () => void
  onUninstall: () => void
}) {
  return (
    <div className={styles.row} onClick={() => onOpen(entry)} data-testid="extension-row">
      <div className={styles.icon}>
        {entry.iconUrl ? (
          <img src={entry.iconUrl} alt="" width={32} height={32} />
        ) : (
          <Package size={28} />
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.title}>
          <span className={styles.name}>{entry.displayName}</span>
          <span className={styles.version}>v{entry.version}</span>
        </div>
        <div className={styles.publisher}>{entry.publisherDisplayName ?? entry.publisher}</div>
        <div className={styles.description}>{entry.description}</div>
      </div>
      <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
        {entry.installing ? (
          <Spinner size={14} />
        ) : entry.installed ? (
          <Button
            variant="secondary"
            onClick={onUninstall}
            className={cx(entry.outdated && styles.outdated)}
          >
            {localize('extensions.uninstall', 'Uninstall')}
          </Button>
        ) : (
          <Button onClick={onInstall}>{localize('extensions.install', 'Install')}</Button>
        )}
      </div>
    </div>
  )
}
