/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionsViewToolbar — the Extensions view's title-bar actions, rendered in
 *  the view header via the view toolbar registry. A single `…` button opens the
 *  view's overflow menu: local filters (Built-in / Updates, which write their
 *  tokens into the search box) plus the update commands that used to live in the
 *  title bar. Filter state is shared with the view body through
 *  extensionsViewState.
 *--------------------------------------------------------------------------------------------*/

import { forwardRef, useCallback, useEffect, useRef, useState, type HTMLAttributes } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'
import { IContextKeyService, localize } from '@universe-editor/platform'
import { AnchoredSurface, IconButton, useCtrlNavigationLayer } from '@universe-editor/workbench-ui'
import { useEventValue, useExecuteCommand, useObservable, useService } from '../useService.js'
import {
  parseExtensionListQuery,
  toggleExtensionListFilter,
  type ExtensionListFilter,
} from '../../services/extensionsWorkbench/extensionListQuery.js'
import { EXTENSIONS_HAS_UPDATES_KEY } from '../../services/extensionsWorkbench/extensionsViewIds.js'
import {
  CheckForExtensionUpdatesAction,
  UpdateAllExtensionsAction,
} from '../../actions/extensionsActions.js'
import { extensionsViewState } from './extensionsViewState.js'
import styles from './ExtensionsViewToolbar.module.css'

export function ExtensionsViewToolbar() {
  const contextKeyService = useService(IContextKeyService)
  const executeCommand = useExecuteCommand()
  const query = useObservable(extensionsViewState.query)
  const hasUpdates = useEventValue(
    contextKeyService.onDidChangeContext,
    useCallback(
      () => contextKeyService.get(EXTENSIONS_HAS_UPDATES_KEY) === true,
      [contextKeyService],
    ),
  )
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)

  return (
    <>
      <IconButton
        ref={triggerRef}
        label={localize('extensions.moreActions', 'More Actions...')}
        active={open}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="extensions-more-actions"
        onMouseDown={(e) => {
          // AnchoredSurface dismisses on outside mousedown. Without this, the
          // click that follows would immediately reopen the menu.
          if (open) e.stopPropagation()
        }}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} strokeWidth={1.6} aria-hidden="true" />
      </IconButton>
      {open && triggerRef.current ? (
        <ExtensionsMenu
          anchor={triggerRef.current}
          query={query}
          hasUpdates={hasUpdates}
          onToggleFilter={(filter) =>
            extensionsViewState.setQuery(toggleExtensionListFilter(query, filter))
          }
          onRunCommand={(command) => {
            setOpen(false)
            void executeCommand(command).catch(() => undefined)
          }}
          onClose={() => setOpen(false)}
          onEscape={() => {
            setOpen(false)
            triggerRef.current?.focus()
          }}
        />
      ) : null}
    </>
  )
}

interface ExtensionsMenuProps {
  readonly anchor: HTMLButtonElement
  readonly query: string
  readonly hasUpdates: boolean
  readonly onToggleFilter: (filter: ExtensionListFilter) => void
  readonly onRunCommand: (command: string) => void
  readonly onClose: () => void
  readonly onEscape: () => void
}

type MenuMove = 'down' | 'up' | 'home' | 'end'

/** Roving focus across the menu's menuitem rows, wrapping at both ends. */
function moveMenuFocus(items: readonly HTMLElement[], current: number, move: MenuMove): void {
  if (items.length === 0) return
  const next =
    move === 'home'
      ? 0
      : move === 'end'
        ? items.length - 1
        : move === 'down'
          ? (current + 1) % items.length
          : current <= 0
            ? items.length - 1
            : current - 1
  items[next]?.focus()
}

function ExtensionsMenu({
  anchor,
  query,
  hasUpdates,
  onToggleFilter,
  onRunCommand,
  onClose,
  onEscape,
}: ExtensionsMenuProps) {
  const rect = anchor.getBoundingClientRect()

  // Ctrl+P/N/J/K drive the same roving focus as the arrows. A registry layer
  // (rather than the surface's onKeyDown) is required because the global
  // dispatcher would otherwise turn Ctrl+K into the chord leader and Ctrl+P/N
  // into quick open / new file.
  useCtrlNavigationLayer({
    kind: 'menu',
    directions: ['up', 'down'],
    onMove: (direction) => {
      const menu = anchor.ownerDocument.querySelector<HTMLElement>(
        '[data-testid="extensions-more-menu"]',
      )
      if (!menu) return
      const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
      const current = items.indexOf(anchor.ownerDocument.activeElement as HTMLElement)
      moveMenuFocus(items, current, direction === 'down' ? 'down' : 'up')
    },
  })

  return (
    <AnchoredSurface
      x={rect.right}
      y={rect.bottom}
      placement="bottom-end"
      offset={4}
      onClose={onClose}
      onEscape={() => {
        onEscape()
        return true
      }}
      surfaceProps={
        {
          role: 'menu',
          className: styles.menu,
          'data-testid': 'extensions-more-menu',
          onKeyDown: (e) => {
            if (
              e.key !== 'ArrowDown' &&
              e.key !== 'ArrowUp' &&
              e.key !== 'Home' &&
              e.key !== 'End'
            ) {
              return
            }
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
            if (items.length === 0) return
            e.preventDefault()
            const current = items.indexOf(e.target as HTMLElement)
            moveMenuFocus(
              items,
              current,
              e.key === 'Home'
                ? 'home'
                : e.key === 'End'
                  ? 'end'
                  : e.key === 'ArrowDown'
                    ? 'down'
                    : 'up',
            )
          },
          onBlur: (e) => {
            const next = e.relatedTarget as Node | null
            if (next === null || e.currentTarget.contains(next)) return
            onClose()
          },
        } as HTMLAttributes<HTMLDivElement>
      }
    >
      <ExtensionsMenuBody
        query={query}
        hasUpdates={hasUpdates}
        onToggleFilter={onToggleFilter}
        onRunCommand={onRunCommand}
      />
    </AnchoredSurface>
  )
}

/**
 * Rendered inside AnchoredSurface: FloatingPortal mounts its children a commit
 * after the surface first renders, so focusing the first row must live here —
 * the outer menu component's effect would see the ref before the portal exists.
 */
function ExtensionsMenuBody({
  query,
  hasUpdates,
  onToggleFilter,
  onRunCommand,
}: {
  readonly query: string
  readonly hasUpdates: boolean
  readonly onToggleFilter: (filter: ExtensionListFilter) => void
  readonly onRunCommand: (command: string) => void
}) {
  const firstItemRef = useRef<HTMLButtonElement | null>(null)
  const { builtin, outdated } = parseExtensionListQuery(query)

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  return (
    <>
      <MenuCheckItem
        ref={firstItemRef}
        label={localize('extensions.filter.builtin', 'Built-in Extensions')}
        checked={builtin}
        testId="extensions-filter-builtin"
        onClick={() => onToggleFilter('builtin')}
      />
      <MenuCheckItem
        label={localize('extensions.filter.updates', 'Updates')}
        checked={outdated}
        testId="extensions-filter-updates"
        onClick={() => onToggleFilter('updates')}
      />
      <div role="separator" className={styles.separator} />
      <MenuActionItem
        label={localize('action.extensions.checkForUpdates', 'Check for Extension Updates')}
        testId="extensions-menu-check-for-updates"
        onClick={() => onRunCommand(CheckForExtensionUpdatesAction.ID)}
      />
      {hasUpdates ? (
        <MenuActionItem
          label={localize('action.extensions.updateAll', 'Update All Extensions')}
          testId="extensions-menu-update-all"
          onClick={() => onRunCommand(UpdateAllExtensionsAction.ID)}
        />
      ) : null}
    </>
  )
}

const MenuCheckItem = forwardRef<
  HTMLButtonElement,
  {
    readonly label: string
    readonly checked: boolean
    readonly testId: string
    readonly onClick: () => void
  }
>(function MenuCheckItem({ label, checked, testId, onClick }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className={styles.item}
      data-testid={testId}
      onClick={onClick}
    >
      <span className={styles.check} aria-hidden="true">
        {checked ? <Check size={14} strokeWidth={2} /> : null}
      </span>
      <span>{label}</span>
    </button>
  )
})

function MenuActionItem({
  label,
  testId,
  onClick,
}: {
  readonly label: string
  readonly testId: string
  readonly onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={styles.item}
      data-testid={testId}
      onClick={onClick}
    >
      <span className={styles.check} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}
