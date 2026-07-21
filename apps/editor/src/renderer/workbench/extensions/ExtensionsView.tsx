/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionsView — the Extensions viewlet. INSTALLED is always shown; when a
 *  marketplace is configured (GALLERY_URL set) a search box drives it and the
 *  "Market Extensions" group lists installable extensions (most-installed by
 *  default, search results while typing). With no marketplace the search box +
 *  Market group hide and only INSTALLED remains, alongside "install from VSIX".
 *  Dropping a `.vsix` file onto the view installs/updates it. Focusing the view
 *  (Ctrl+Shift+X) puts the caret in the search box. Clicking a row opens its
 *  detail editor. All state is read through IExtensionsWorkbenchService.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, Settings } from 'lucide-react'
import { IEditorService, INotificationService, Severity, localize } from '@universe-editor/platform'
import {
  Button,
  IconButton,
  Input,
  Spinner,
  cx,
  dragContainsResources,
  useScrollRestore,
} from '@universe-editor/workbench-ui'
import { useEventValue, useService } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import { readDroppedResources } from '../../services/dnd/resourceDropTransfer.js'
import {
  IExtensionsWorkbenchService,
  EnablementState,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import { ExtensionEditorInput } from '../../services/editor/ExtensionEditorInput.js'
import { ExtensionIcon } from './ExtensionIcon.js'
import { ExtensionActionsMenu, type ExtensionActionsMenuState } from './ExtensionActionsMenu.js'
import styles from './ExtensionsView.module.css'

const SEARCH_DEBOUNCE_MS = 300

/** The view id — must match the descriptor registered in ExtensionsViewContribution. */
const VIEW_ID = 'workbench.view.extensions.main'

export function ExtensionsView() {
  const service = useService(IExtensionsWorkbenchService)
  const editorService = useService(IEditorService)
  const notificationService = useService(INotificationService)

  // Re-read the facade's live snapshot whenever it fires onDidChange.
  const { installed, searching, results } = useEventValue(
    service.onDidChange,
    useCallback(
      () => ({
        installed: service.getInstalled(),
        searching: service.searching,
        results: service.getSearchResults(),
      }),
      [service],
    ),
  )

  const [marketplaceEnabled, setMarketplaceEnabled] = useState(false)
  const [query, setQuery] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const [menu, setMenu] = useState<ExtensionActionsMenuState | undefined>(undefined)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useScrollRestore(
    'extensions',
    useCallback(() => scrollRef.current, []),
  )

  useViewFocusable(
    VIEW_ID,
    useCallback(() => inputRef.current, []),
  )

  useEffect(() => {
    void service.isMarketplaceEnabled().then((enabled) => {
      setMarketplaceEnabled(enabled)
      if (enabled) void service.loadFeatured()
    })
    void service.refreshInstalled()
  }, [service])

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        if (value.trim()) void service.search(value)
        else void service.loadFeatured()
      }, SEARCH_DEBOUNCE_MS)
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

  const openMenu = useCallback((entry: IExtensionEntry, x: number, y: number) => {
    setMenu({ entry, x, y })
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!dragContainsResources(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when the pointer actually leaves the view, not on child enter.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDropActive(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!dragContainsResources(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      setDropActive(false)
      const resources = readDroppedResources(e)
      if (resources.length === 0) return
      const nonVsix = resources.filter((uri) => !/\.vsix$/i.test(uri.fsPath))
      if (nonVsix.length > 0) {
        notificationService.notify({
          severity: Severity.Error,
          message: localize(
            'extensions.drop.notVsix',
            'Only .vsix packages can be installed by dropping them here.',
          ),
        })
        return
      }
      for (const uri of resources) void service.installVSIX(uri.fsPath)
    },
    [service, notificationService],
  )

  return (
    <div
      className={cx(styles.container, dropActive && styles.dropActive)}
      data-testid="extensions-view"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {marketplaceEnabled && (
        <div className={styles.searchRow}>
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={localize('extensions.search.placeholder', 'Search Extensions Marketplace')}
            aria-label={localize('extensions.search.label', 'Search Extensions')}
          />
        </div>
      )}

      <div className={styles.scroll} ref={scrollRef}>
        <Section title={localize('extensions.group.installed', 'Installed')}>
          {installed.map((entry) => (
            <ExtensionRow
              key={entry.id}
              entry={entry}
              onOpen={openDetail}
              onInstall={() => void service.install(entry)}
              onOpenMenu={openMenu}
            />
          ))}
          {installed.length === 0 && (
            <div className={styles.empty}>
              {localize('extensions.noneInstalled', 'No extensions installed')}
            </div>
          )}
        </Section>

        {marketplaceEnabled && (
          <Section
            title={localize('extensions.group.marketplace', 'Market Extensions')}
            loading={searching}
          >
            {results.map((entry) => (
              <ExtensionRow
                key={entry.id}
                entry={entry}
                onOpen={openDetail}
                onInstall={() => void service.install(entry)}
                onOpenMenu={openMenu}
              />
            ))}
            {!searching && results.length === 0 && (
              <div className={styles.empty}>
                {localize('extensions.noResults', 'No extensions found')}
              </div>
            )}
          </Section>
        )}
      </div>

      {menu && (
        <ExtensionActionsMenu
          state={menu}
          handlers={{
            hasWorkspace: service.hasWorkspace(),
            onOpen: openDetail,
            onUninstall: (entry) => void service.uninstall(entry),
            onSetEnablement: (entry, state) => void service.setEnablement(entry, state),
          }}
          onClose={() => setMenu(undefined)}
        />
      )}
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
  onOpenMenu,
}: {
  entry: IExtensionEntry
  onOpen: (entry: IExtensionEntry) => void
  onInstall: () => void
  onOpenMenu: (entry: IExtensionEntry, x: number, y: number) => void
}) {
  const disabled = entry.installed && !entry.enabled
  const workspaceScoped =
    entry.enablementState === EnablementState.DisabledWorkspace ||
    entry.enablementState === EnablementState.EnabledWorkspace
  const onContextMenu = (e: React.MouseEvent) => {
    if (!entry.installed) return
    e.preventDefault()
    e.stopPropagation()
    onOpenMenu(entry, e.clientX, e.clientY)
  }
  return (
    <div
      className={cx(styles.row, disabled && styles.disabledRow)}
      onClick={() => onOpen(entry)}
      onContextMenu={onContextMenu}
      data-testid="extension-row"
    >
      <div className={styles.icon}>
        <ExtensionIcon entry={entry} size={42} />
      </div>
      <div className={styles.body}>
        <div className={styles.title}>
          <span className={styles.name}>{entry.displayName}</span>
          {disabled && (
            <span className={cx(styles.badge, styles.disabledBadge)}>
              {workspaceScoped
                ? localize('extensions.disabledWorkspace', 'Disabled (Workspace)')
                : localize('extensions.disabled', 'Disabled')}
            </span>
          )}
          {entry.activationError && (
            <span
              className={cx(styles.badge, styles.errorBadge)}
              title={entry.activationError.stack ?? entry.activationError.message}
              data-testid="extension-activation-error"
            >
              {localize('extensions.activationFailed', 'Activation Failed')}
            </span>
          )}
        </div>
        <div className={styles.description}>{entry.description}</div>
        <div className={styles.footer}>
          <span className={styles.publisher}>
            {entry.publisherDisplayName ?? (entry.publisher || (entry.isBuiltin ? 'universe' : ''))}
          </span>
          <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
            {entry.isBuiltin && (
              <span
                className={styles.builtinIcon}
                title={localize('extensions.builtin', 'Built-in')}
                aria-label={localize('extensions.builtin', 'Built-in')}
              >
                <ShieldCheck size={15} />
              </span>
            )}
            {entry.installing ? (
              <Spinner size={14} />
            ) : entry.installed ? (
              <IconButton
                label={localize('extensions.manage', 'Manage')}
                onClick={(e) =>
                  onOpenMenu(
                    entry,
                    e.currentTarget.getBoundingClientRect().left,
                    e.currentTarget.getBoundingClientRect().bottom,
                  )
                }
                data-testid="extension-manage"
              >
                <Settings size={16} />
              </IconButton>
            ) : (
              <Button onClick={onInstall}>{localize('extensions.install', 'Install')}</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
