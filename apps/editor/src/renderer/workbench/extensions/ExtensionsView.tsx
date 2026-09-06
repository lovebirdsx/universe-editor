/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionsView — the Extensions viewlet. The INSTALLED group lists user-
 *  installed extensions only (VSCode parity: built-ins stay out of the default
 *  list); typing `@builtin` in the search box lists the built-in extensions
 *  instead (plain text filters the local list by id/name/description). When a
 *  marketplace is configured (GALLERY_URL set) the "Market Extensions" group
 *  lists installable extensions (most-installed by default, search results
 *  while typing) — marketplace search is skipped for local queries. Dropping
 *  a `.vsix` file onto the view installs/updates it. Focusing the view
 *  (Ctrl+Shift+X) puts the caret in the search box. Clicking a row opens its
 *  detail editor. All state is read through IExtensionsWorkbenchService.
 *
 *  The sections are flattened into one row list so the arrow keys cross section
 *  boundaries in a single index space (`useFlatListNavigation`, the same
 *  keyboard model the trees get from `Tree`). That is also why section collapse
 *  state lives here rather than inside `Section` — the flattening has to know
 *  which bodies are folded away.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ShieldCheck, Settings } from 'lucide-react'
import { IEditorService, INotificationService, Severity, localize } from '@universe-editor/platform'
import {
  Button,
  IconButton,
  Input,
  Spinner,
  cx,
  dragContainsResources,
  isKeyboardContextMenu,
  useFlatListNavigation,
  useScrollRestore,
  type IFlatListNavigation,
  type IFlatListRowProps,
} from '@universe-editor/workbench-ui'
import { useEventValue, useService } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import { readDroppedResources } from '../../services/dnd/resourceDropTransfer.js'
import {
  IExtensionsWorkbenchService,
  EnablementState,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import {
  filterExtensionEntries,
  parseExtensionListQuery,
} from '../../services/extensionsWorkbench/extensionListQuery.js'
import { ExtensionEditorInput } from '../../services/editor/ExtensionEditorInput.js'
import { ExtensionIcon } from './ExtensionIcon.js'
import { InstallInRemoteButton } from './InstallInRemoteButton.js'
import { ExtensionActionsMenu, type ExtensionActionsMenuState } from './ExtensionActionsMenu.js'
import styles from './ExtensionsView.module.css'

const SEARCH_DEBOUNCE_MS = 300

/** The view id — must match the descriptor registered in ExtensionsViewContribution. */
const VIEW_ID = 'workbench.view.extensions.main'

interface ExtensionsSection {
  readonly id: string
  readonly title: string
  readonly loading?: boolean
  readonly entries: readonly IExtensionEntry[]
  /** Shown in place of the entries when there are none. */
  readonly emptyMessage: string
}

type ExtensionsRow =
  | { readonly kind: 'header'; readonly key: string; readonly section: ExtensionsSection }
  | {
      readonly kind: 'entry'
      readonly key: string
      readonly entry: IExtensionEntry
    }
  | { readonly kind: 'empty'; readonly key: string; readonly message: string }

/** A navigable row: everything except the "nothing here" placeholders. */
type ExtensionsNavRow = Exclude<ExtensionsRow, { kind: 'empty' }>

interface FlattenedRows {
  /** Render order, placeholders included. */
  readonly rows: readonly ExtensionsRow[]
  /**
   * The arrow-key index space. Placeholder rows are excluded: they carry no
   * action, so stopping on one would show the user a cursor that does nothing.
   * `rows[i].navIndex` is therefore not `i` — use `navIndexOf`.
   */
  readonly navigable: readonly ExtensionsNavRow[]
  /** Render index → navigation index, or -1 for a placeholder. */
  readonly navIndexOf: readonly number[]
  /** Navigation index → its section header's navigation index. */
  readonly headerNavIndexOf: readonly number[]
}

function flattenSections(
  sections: readonly ExtensionsSection[],
  collapsed: ReadonlySet<string>,
): FlattenedRows {
  const rows: ExtensionsRow[] = []
  const navigable: ExtensionsNavRow[] = []
  const navIndexOf: number[] = []
  const headerNavIndexOf: number[] = []
  let currentHeaderNavIndex = -1

  const push = (row: ExtensionsRow) => {
    rows.push(row)
    if (row.kind === 'empty') {
      navIndexOf.push(-1)
      return
    }
    navIndexOf.push(navigable.length)
    if (row.kind === 'header') currentHeaderNavIndex = navigable.length
    headerNavIndexOf.push(currentHeaderNavIndex)
    navigable.push(row)
  }

  for (const section of sections) {
    push({ kind: 'header', key: `header:${section.id}`, section })
    if (collapsed.has(section.id)) continue
    for (const entry of section.entries) {
      // Namespaced: the same extension can appear under both INSTALLED and
      // MARKETPLACE, and a duplicated row key would collapse them into one.
      push({ kind: 'entry', key: `${section.id}:${entry.id}`, entry })
    }
    if (section.entries.length === 0 && section.loading !== true) {
      push({ kind: 'empty', key: `empty:${section.id}`, message: section.emptyMessage })
    }
  }
  return { rows, navigable, navIndexOf, headerNavIndexOf }
}

export function ExtensionsView() {
  const service = useService(IExtensionsWorkbenchService)
  const editorService = useService(IEditorService)
  const notificationService = useService(INotificationService)

  // Re-read the facade's live snapshot whenever it fires onDidChange.
  const { installed, searching, results, remoteLabel } = useEventValue(
    service.onDidChange,
    useCallback(
      () => ({
        installed: service.getInstalled(),
        searching: service.searching,
        results: service.getSearchResults(),
        remoteLabel: service.remoteLabel,
      }),
      [service],
    ),
  )

  const [marketplaceEnabled, setMarketplaceEnabled] = useState(false)
  const [query, setQuery] = useState('')
  const listQuery = parseExtensionListQuery(query)
  const [dropActive, setDropActive] = useState(false)
  const [menu, setMenu] = useState<ExtensionActionsMenuState | undefined>(undefined)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const getContainer = useCallback(() => scrollRef.current, [])

  useScrollRestore('extensions', getContainer)

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
        // Local queries (@builtin / plain text over the installed list) never
        // hit the marketplace.
        if (parseExtensionListQuery(value).builtin) return
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

  const openMenu = useCallback((entry: IExtensionEntry, x: number, y: number, keyboard = false) => {
    setMenu({ entry, x, y, keyboard })
  }, [])

  const toggleSection = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const setSectionCollapsed = useCallback((id: string, value: boolean) => {
    setCollapsed((prev) => {
      if (prev.has(id) === value) return prev
      const next = new Set(prev)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const noResults = localize('extensions.noResults', 'No extensions found')
  // The entry filtering lives inside the memo rather than above it: every step
  // allocates a fresh array, so hoisting it would give `sections` a new input
  // identity on every render and defeat both this memo and `rows` below.
  const sections = useMemo<readonly ExtensionsSection[]>(() => {
    const visibleEntries = filterExtensionEntries(installed, listQuery)
    // In a remote workspace the INSTALLED group splits into the effective remote
    // side and the local side (built-ins are only listed under @builtin, which
    // keeps the single-section rendering below).
    const splitRemote = remoteLabel !== undefined && !listQuery.builtin

    const list: ExtensionsSection[] = []
    if (splitRemote) {
      list.push({
        id: 'remote',
        title: remoteLabel,
        entries: visibleEntries.filter((e) => e.remote === true),
        emptyMessage: listQuery.text
          ? noResults
          : localize('extensions.noneInstalled', 'No extensions installed'),
      })
      list.push({
        id: 'local',
        title: localize('extensions.group.local', 'Local'),
        entries: visibleEntries.filter((e) => e.remote !== true),
        emptyMessage: localize('extensions.noneInstalled.local', 'No local extensions installed'),
      })
    } else {
      list.push({
        id: 'installed',
        title: listQuery.builtin
          ? localize('extensions.group.builtin', 'Built-in')
          : localize('extensions.group.installed', 'Installed'),
        entries: visibleEntries,
        emptyMessage:
          listQuery.text || listQuery.builtin
            ? noResults
            : localize('extensions.noneInstalled', 'No extensions installed'),
      })
    }
    if (marketplaceEnabled && !listQuery.builtin) {
      list.push({
        id: 'marketplace',
        title: localize('extensions.group.marketplace', 'Market Extensions'),
        loading: searching,
        entries: results,
        emptyMessage: noResults,
      })
    }
    return list
  }, [
    installed,
    remoteLabel,
    listQuery.builtin,
    listQuery.text,
    marketplaceEnabled,
    searching,
    results,
    noResults,
  ])

  const { rows, navigable, navIndexOf, headerNavIndexOf } = useMemo(
    () => flattenSections(sections, collapsed),
    [sections, collapsed],
  )

  // Searching, collapsing a section or an install finishing all shorten the
  // list, which would otherwise leave the cursor past the end.
  const clampedFocusedIndex = focusedIndex >= navigable.length ? -1 : focusedIndex

  // ArrowLeft/ArrowRight need to move the cursor, but the mover comes out of the
  // very hook this handler is passed to — read it through a ref rather than
  // closing over a value that does not exist yet.
  const navRef = useRef<IFlatListNavigation | undefined>(undefined)

  const nav = useFlatListNavigation({
    count: navigable.length,
    focusedIndex: clampedFocusedIndex,
    onFocusChange: setFocusedIndex,
    getItemKey: useCallback((index: number) => navigable[index]?.key ?? '', [navigable]),
    getContainer,
    ariaLabel: localize('extensions.list', 'Extensions'),
    onActivate: useCallback(
      (index: number) => {
        const row = navigable[index]
        if (row?.kind === 'header') toggleSection(row.section.id)
        else if (row?.kind === 'entry') openDetail(row.entry)
      },
      [navigable, toggleSection, openDetail],
    ),
    // Tree parity for the section headers: Left folds an expanded section (or
    // jumps an entry back to its header), Right expands a folded one (or steps
    // into its first entry).
    onRowKeyDown: useCallback(
      (e: React.KeyboardEvent, index: number) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        const row = navigable[index]
        if (!row) return
        e.preventDefault()
        e.stopPropagation()
        if (row.kind === 'entry') {
          const headerIndex = headerNavIndexOf[index] ?? -1
          if (e.key === 'ArrowLeft' && headerIndex >= 0) navRef.current?.focusRow(headerIndex)
          return
        }
        const isCollapsed = collapsed.has(row.section.id)
        if (e.key === 'ArrowLeft') {
          setSectionCollapsed(row.section.id, true)
        } else if (isCollapsed) {
          setSectionCollapsed(row.section.id, false)
        } else if (row.section.entries.length > 0) {
          navRef.current?.focusRow(index + 1)
        }
      },
      [navigable, headerNavIndexOf, collapsed, setSectionCollapsed],
    ),
    onShiftTab: useCallback(() => inputRef.current?.focus(), []),
  })
  navRef.current = nav

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
      // 本机路径，不随远端工作区变化：拖入的 .vsix 均来自 OS 本机拖放。
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
      <div className={styles.searchRow}>
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={localize(
            'extensions.search.placeholder',
            'Search Extensions (@builtin for built-ins)',
          )}
          aria-label={localize('extensions.search.label', 'Search Extensions')}
        />
      </div>

      <div {...nav.containerProps} className={styles.scroll} ref={scrollRef}>
        {rows.map((row, index) => {
          if (row.kind === 'empty') {
            return (
              <div key={row.key} className={styles.empty} role="presentation">
                {row.message}
              </div>
            )
          }
          // Render order != navigation order: placeholders are skipped, so the
          // cursor index has to come from the flattener's mapping.
          const rowProps = nav.getRowProps(navIndexOf[index]!)
          if (row.kind === 'header') {
            return (
              <SectionHeader
                key={row.key}
                section={row.section}
                collapsed={collapsed.has(row.section.id)}
                onToggle={() => toggleSection(row.section.id)}
                rowProps={rowProps}
              />
            )
          }
          return (
            <ExtensionRow
              key={row.key}
              entry={row.entry}
              onOpen={openDetail}
              onInstall={() => void service.install(row.entry)}
              onOpenMenu={openMenu}
              rowProps={rowProps}
            />
          )
        })}
      </div>

      {menu && (
        <ExtensionActionsMenu
          state={menu}
          handlers={{
            hasWorkspace: service.hasWorkspace(),
            onOpen: openDetail,
            onUninstall: (entry) => void service.uninstall(entry),
            onSetEnablement: (entry, state) => void service.setEnablement(entry, state),
            onInstallInRemote: (entry) => void service.installInRemote(entry),
          }}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  )
}

function SectionHeader({
  section,
  collapsed,
  onToggle,
  rowProps,
}: {
  section: ExtensionsSection
  collapsed: boolean
  onToggle: () => void
  rowProps: IFlatListRowProps
}) {
  return (
    <div
      {...rowProps}
      className={styles.sectionHeader}
      aria-expanded={!collapsed}
      data-testid="extension-section-header"
      onClick={(e) => {
        rowProps.onClick(e)
        onToggle()
      }}
    >
      {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
      <span className={styles.sectionTitle}>{section.title}</span>
      {section.loading === true && <Spinner size={12} />}
    </div>
  )
}

function ExtensionRow({
  entry,
  onOpen,
  onInstall,
  onOpenMenu,
  rowProps,
}: {
  entry: IExtensionEntry
  onOpen: (entry: IExtensionEntry) => void
  onInstall: () => void
  onOpenMenu: (entry: IExtensionEntry, x: number, y: number, keyboard?: boolean) => void
  rowProps: IFlatListRowProps
}) {
  const userDisabled = entry.installed && !entry.enabled
  const versionIncompatible = entry.isVersionIncompatible
  const rowDisabled = userDisabled || versionIncompatible
  const workspaceScoped =
    entry.enablementState === EnablementState.DisabledWorkspace ||
    entry.enablementState === EnablementState.EnabledWorkspace
  const onContextMenu = (e: React.MouseEvent) => {
    if (!entry.installed) return
    e.preventDefault()
    e.stopPropagation()
    onOpenMenu(entry, e.clientX, e.clientY, isKeyboardContextMenu(e))
  }
  return (
    <div
      {...rowProps}
      className={cx(styles.row, rowDisabled && styles.disabledRow)}
      onClick={(e) => {
        rowProps.onClick(e)
        onOpen(entry)
      }}
      onContextMenu={onContextMenu}
      data-testid="extension-row"
    >
      <div className={styles.icon}>
        <ExtensionIcon entry={entry} size={42} />
      </div>
      <div className={styles.body}>
        <div className={styles.title}>
          <span className={styles.name}>{entry.displayName}</span>
          {entry.isUnderDevelopment && (
            <span
              className={styles.badge}
              data-tooltip={entry.local?.location}
              data-testid="extension-dev-badge"
            >
              {localize('extensions.development', 'Development')}
            </span>
          )}
          {userDisabled && (
            <span className={cx(styles.badge, styles.disabledBadge)}>
              {workspaceScoped
                ? localize('extensions.disabledWorkspace', 'Disabled (Workspace)')
                : localize('extensions.disabled', 'Disabled')}
            </span>
          )}
          {versionIncompatible && (
            <span
              className={cx(styles.badge, styles.disabledBadge)}
              data-tooltip={entry.validationMessage}
              data-testid="extension-version-incompatible"
            >
              {localize('extensions.versionIncompatible', 'Disabled (requires universe {reason})', {
                reason: entry.validationMessage ?? '',
              })}
            </span>
          )}
          {!entry.installed && entry.installIncompatible && (
            <span
              className={cx(styles.badge, styles.disabledBadge)}
              data-testid="extension-install-incompatible"
            >
              {localize('extensions.installIncompatible', 'Incompatible with current version')}
            </span>
          )}
          {!entry.installed && entry.installCompatibleVersion !== undefined && (
            <span className={styles.badge} data-testid="extension-install-compatible-version">
              {localize('extensions.installCompatibleVersion', 'Will install version {version}', {
                version: entry.installCompatibleVersion,
              })}
            </span>
          )}
          {entry.activationError && (
            <span
              className={cx(styles.badge, styles.errorBadge)}
              data-tooltip={entry.activationError.stack ?? entry.activationError.message}
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
                data-tooltip={localize('extensions.builtin', 'Built-in')}
                aria-label={localize('extensions.builtin', 'Built-in')}
              >
                <ShieldCheck size={15} />
              </span>
            )}
            {entry.installing ? (
              <Spinner size={14} />
            ) : entry.installableInRemote ? (
              <InstallInRemoteButton
                entry={entry}
                label={localize('extensions.installInRemote', 'Install in Remote')}
                badgeClassName={styles.badge}
              />
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
              <Button onClick={onInstall} disabled={entry.installIncompatible}>
                {localize('extensions.install', 'Install')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
