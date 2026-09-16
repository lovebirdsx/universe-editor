/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigBarOverflowMenu — the "…" button at the end of the single-line
 *  config bar. When the bar cannot show every entry, the low-priority tail
 *  (see configBarLayout.ts) moves into this anchored panel; each row expands
 *  inline because a nested AnchoredSurface would die from the same Escape
 *  (its window-capture handler stopPropagation()s, so both layers would close
 *  at once). The button renders even without overflow — hidden via CSS — so
 *  the overflow measurement can always reserve its width.
 *
 *  Keyboard: the panel holds focus and carries a cursor over its rows, and an
 *  expanded body carries its own list cursor. The two form one sequence — up at
 *  a body's first row collapses it and lands back on its row, down at the last
 *  row continues to the next row — so nothing ever traps the cursor. Escape
 *  peels one level at a time (collapse the row, then dismiss the panel); it is
 *  wired to AnchoredSurface's `onEscape` because that surface owns the key on
 *  window capture, ahead of both the workbench dispatcher and React.
 *
 *  `expandedKey` is controlled by ConfigOptionsBar: a row has to be expandable
 *  from outside for Alt+<n> to reach an entry the bar folded away.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react'
import { ChevronRight, MoreHorizontal, Plug, Users } from 'lucide-react'
import { IDialogService, INotificationService, localize } from '@universe-editor/platform'
import { AnchoredSurface, useOverlayListNavigation } from '@universe-editor/workbench-ui'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { useClaudeConfig } from '../agentSettings/claude/useClaudeConfig.js'
import { useObservable, useOptionalService, useService } from '../useService.js'
import { resolveMcpServerSelection } from '../../services/acp/acpMcpServers.js'
import { findConfigOptionLabel } from '../../services/acp/configOptionLabel.js'
import {
  MCP_ENTRY_KEY,
  SUBAGENT_ENTRY_KEY,
  type ConfigBarEntry,
} from '../../services/acp/configBarLayout.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../services/acp/session/acpSessionService.js'
import {
  categoryIcon,
  ConfigOptionPanel,
  pickConfigValue,
  type ConfigBarAnchor,
} from './ConfigOptionsBar.js'
import { isMcpPickerHidden, filterPoolForSession, McpPickerPanel } from './McpServerPicker.js'
import { SubagentModelPanel } from './SubagentModelPicker.js'
import styles from './agents.module.css'

/** Row heading — also what typeahead matches against. */
function entryName(entry: ConfigBarEntry): string {
  switch (entry.kind) {
    case 'option':
      return entry.option.name
    case 'subagent':
      return localize('acp.subagent.label', 'Sub Agent')
    default:
      return localize('acp.mcp.picker.title', 'MCP servers enabled for this session')
  }
}

export function ConfigBarOverflowMenu({
  session,
  entries,
  overflowedKeys,
  open,
  anchor,
  expandedKey,
  onExpandedKeyChange,
  onOpen,
  onClose,
  onAltDigit,
  buttonRef,
}: {
  session: IAcpSession
  entries: readonly ConfigBarEntry[]
  overflowedKeys: ReadonlySet<string>
  open: boolean
  anchor: ConfigBarAnchor | null
  /** Controlled: which row shows its body inline, if any. */
  expandedKey: string | null
  onExpandedKeyChange: (key: string | null) => void
  onOpen: (trigger: HTMLElement) => void
  onClose: () => void
  onAltDigit: (digit: number) => void
  buttonRef: Ref<HTMLButtonElement>
}) {
  const overflowEntries = entries.filter((e) => overflowedKeys.has(e.key))
  const hasOverflow = overflowEntries.length > 0
  const panelElRef = useRef<HTMLDivElement | null>(null)

  // A row that leaves the overflow set unmounts while expanded; clear it so it
  // does not come back pre-expanded.
  useEffect(() => {
    if (expandedKey !== null && !overflowedKeys.has(expandedKey)) onExpandedKeyChange(null)
  }, [expandedKey, overflowedKeys, onExpandedKeyChange])

  const expandedIndex = overflowEntries.findIndex((e) => e.key === expandedKey)

  const rowNav = useOverlayListNavigation({
    count: overflowEntries.length,
    // The cursor starts at the top of the rows. It is NOT seeded from
    // `expandedKey`: that would re-seed on every collapse and drag the user's
    // cursor back. Every path that leaves a body (`onExitUp`/`onExitDown`,
    // Escape) sets it explicitly instead.
    initialIndex: 0,
    onActivate: (index) => {
      const entry = overflowEntries[index]
      if (entry) onExpandedKeyChange(entry.key === expandedKey ? null : entry.key)
    },
    getTypeaheadText: (index) => {
      const entry = overflowEntries[index]
      return entry ? entryName(entry) : ''
    },
    // No wrap: the ends are where an expanded body hands the cursor back.
    wrap: false,
    // Alt+<n> opens the panel with its target row already expanded, and host
    // refs fire child-first — without this the row container would take focus
    // straight back out of the body the user asked to land in.
    autoFocus: expandedKey === null,
    ariaLabel: localize('acp.config.more', 'More options…'),
  })

  // Destructured so the callbacks below depend on the (stable) members rather
  // than on `rowNav`, whose object identity is fresh on every render.
  const { containerRef: rowContainerRef, setActiveIndex: setRowActiveIndex } = rowNav

  const setPanelEl = useCallback(
    (node: HTMLDivElement | null) => {
      panelElRef.current = node
      rowContainerRef(node)
    },
    [rowContainerRef],
  )

  const focusRow = useCallback(
    (index: number) => {
      setRowActiveIndex(index)
      panelElRef.current?.focus({ preventScroll: true })
    },
    [setRowActiveIndex],
  )

  // Leaving an expanded body hands the cursor back to the rows and collapses it,
  // so the panel is never left with an expanded row the cursor is not in. Up
  // returns to the row that owns the body, down carries on to the next one;
  // `expandedIndex < 0` (the row is unknown, so nothing can be expanded) lands
  // on the first row either way rather than off the end.
  const leaveBody = useCallback(
    (delta: 0 | 1) => {
      onExpandedKeyChange(null)
      focusRow(Math.max(0, Math.min(expandedIndex + delta, overflowEntries.length - 1)))
    },
    [expandedIndex, overflowEntries.length, onExpandedKeyChange, focusRow],
  )

  const escapePanel = useCallback((): boolean => {
    if (expandedKey !== null) {
      leaveBody(0)
      return true
    }
    // About to dismiss: hand the cursor back to the "…" button. AnchoredSurface
    // calls onClose right after, so the panel is gone once focus lands.
    const button = buttonRef as { current?: HTMLButtonElement | null } | null
    button?.current?.focus()
    return false
  }, [expandedKey, leaveBody, buttonRef])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles['configOverflowButton']}
        data-empty={hasOverflow ? undefined : 'true'}
        data-testid="acp-config-overflow-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={localize('acp.config.more', 'More options…')}
        onMouseDown={(e) => {
          // The surface's outside-press listens on document mousedown; without
          // this the same click would dismiss and the click below would
          // immediately reopen the panel.
          e.stopPropagation()
        }}
        onClick={(e) => {
          if (open) {
            onClose()
            return
          }
          onOpen(e.currentTarget)
        }}
      >
        <MoreHorizontal size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && anchor !== null ? (
        <AnchoredSurface
          x={anchor.x}
          y={anchor.y}
          placement="top-start"
          offset={4}
          onClose={onClose}
          onEscape={escapePanel}
          surfaceProps={
            {
              className: styles['configOverflowPanel'],
              role: 'dialog',
              'aria-label': localize('acp.config.more', 'More options…'),
              'data-testid': 'acp-config-overflow-panel',
            } as HTMLAttributes<HTMLDivElement>
          }
        >
          {/* The panel's rows are disclosure buttons, not `option`s — each one
              expands a body — so this is a plain focusable group. The hook's
              `listbox` role is dropped rather than nested: a listbox inside a
              listbox is invalid, and an expanded row's body is itself a listbox. */}
          <div ref={setPanelEl} {...rowNav.containerProps} role={undefined}>
            {overflowEntries.map((entry, index) => (
              <OverflowRow
                key={entry.key}
                session={session}
                entry={entry}
                active={index === rowNav.activeIndex}
                expanded={expandedKey === entry.key}
                onToggle={() => onExpandedKeyChange(expandedKey === entry.key ? null : entry.key)}
                onRequestClose={onClose}
                onAltDigit={onAltDigit}
                onExitUp={() => leaveBody(0)}
                onExitDown={() => leaveBody(1)}
              />
            ))}
          </div>
        </AnchoredSurface>
      ) : null}
    </>
  )
}

function OverflowRow({
  session,
  entry,
  active,
  expanded,
  onToggle,
  onRequestClose,
  onAltDigit,
  onExitUp,
  onExitDown,
}: {
  session: IAcpSession
  entry: ConfigBarEntry
  /** True while the panel's cursor sits on this row. */
  active: boolean
  expanded: boolean
  onToggle: () => void
  onRequestClose: () => void
  onAltDigit: (digit: number) => void
  onExitUp: () => void
  onExitDown: () => void
}) {
  // The MCP row gates itself on the service and the pool, so its hooks cannot
  // live here — each kind gets its own component rather than a conditional hook.
  if (entry.kind === 'mcp') {
    return (
      <McpOverflowRow
        session={session}
        active={active}
        expanded={expanded}
        onToggle={onToggle}
        onRequestClose={onRequestClose}
        onAltDigit={onAltDigit}
        onExitUp={onExitUp}
        onExitDown={onExitDown}
      />
    )
  }
  if (entry.kind === 'subagent') {
    return (
      <SubagentOverflowRow
        session={session}
        active={active}
        expanded={expanded}
        onToggle={onToggle}
        onAltDigit={onAltDigit}
        onExitUp={onExitUp}
        onExitDown={onExitDown}
      />
    )
  }
  return (
    <OptionOverflowRow
      session={session}
      option={entry.option}
      active={active}
      expanded={expanded}
      onToggle={onToggle}
      onAltDigit={onAltDigit}
      onExitUp={onExitUp}
      onExitDown={onExitDown}
    />
  )
}

/** Shared props of every row kind's expanded body. */
interface IOverflowRowBodyProps {
  /** Lets a body that navigates away (MCP → settings) dismiss the panel first. */
  onRequestClose: () => void
  onAltDigit: (digit: number) => void
  onExitUp: () => void
  onExitDown: () => void
}

/** A select option's body: the same list the inline popover renders. */
function OptionOverflowRow({
  session,
  option,
  active,
  expanded,
  onToggle,
  onAltDigit,
  onExitUp,
  onExitDown,
}: Omit<IOverflowRowBodyProps, 'onRequestClose'> & {
  session: IAcpSession
  option: SessionConfigOption & { type: 'select' }
  active: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const dialogService = useService(IDialogService)
  const notificationService = useService(INotificationService)
  const Icon = categoryIcon(option.category)
  return (
    <OverflowRowLayout
      entryKey={option.id}
      icon={<Icon size={13} strokeWidth={1.75} aria-hidden="true" />}
      name={option.name}
      value={findConfigOptionLabel(option.options, option.currentValue)}
      body={
        <ConfigOptionPanel
          option={option}
          onCommit={(value) => {
            void pickConfigValue(session, option, value, dialogService, notificationService)
          }}
          onAltDigit={onAltDigit}
          onExitUp={onExitUp}
          onExitDown={onExitDown}
        />
      }
      active={active}
      expanded={expanded}
      onToggle={onToggle}
    />
  )
}

function SubagentOverflowRow({
  session,
  active,
  expanded,
  onToggle,
  onAltDigit,
  onExitUp,
  onExitDown,
}: Omit<IOverflowRowBodyProps, 'onRequestClose'> & {
  session: IAcpSession
  active: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const { subagentModelEnv } = useClaudeConfig()
  return (
    <OverflowRowLayout
      entryKey={SUBAGENT_ENTRY_KEY}
      icon={<Users size={13} strokeWidth={1.75} aria-hidden="true" />}
      name={localize('acp.subagent.label', 'Sub Agent')}
      value={subagentModelEnv ?? localize('acp.subagent.inherit', 'Follow main model')}
      body={
        <SubagentModelPanel
          session={session}
          onAltDigit={onAltDigit}
          onExitUp={onExitUp}
          onExitDown={onExitDown}
        />
      }
      active={active}
      expanded={expanded}
      onToggle={onToggle}
    />
  )
}

function OverflowRowLayout({
  entryKey,
  icon,
  name,
  value,
  body,
  active,
  expanded,
  onToggle,
}: {
  entryKey: string
  icon: ReactNode
  name: string
  value: ReactNode
  body: ReactNode
  active: boolean
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className={styles['configOverflowRowWrap']}>
      <button
        type="button"
        className={styles['configOverflowRow']}
        data-entry-key={entryKey}
        data-active={active ? 'true' : undefined}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {icon}
        <span className={styles['configOverflowRowName']}>{name}</span>
        <span className={styles['configOverflowRowValue']}>{value}</span>
        <ChevronRight
          className={styles['configOverflowRowChevron']}
          size={12}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </button>
      {expanded ? <div className={styles['configOverflowRowBody']}>{body}</div> : null}
    </div>
  )
}

function McpOverflowRow({
  session,
  active,
  expanded,
  onToggle,
  onRequestClose,
  onAltDigit,
  onExitUp,
  onExitDown,
}: IOverflowRowBodyProps & {
  session: IAcpSession
  active: boolean
  expanded: boolean
  onToggle: () => void
}) {
  // Soft dependency, like the picker itself: no ACP layer in unit tests means
  // no row at all.
  const service = useOptionalService(IAcpSessionService)
  if (!service) return null
  return (
    <McpOverflowRowInner
      session={session}
      service={service}
      active={active}
      expanded={expanded}
      onToggle={onToggle}
      onRequestClose={onRequestClose}
      onAltDigit={onAltDigit}
      onExitUp={onExitUp}
      onExitDown={onExitDown}
    />
  )
}

function McpOverflowRowInner({
  session,
  service,
  active,
  expanded,
  onToggle,
  onRequestClose,
  onAltDigit,
  onExitUp,
  onExitDown,
}: IOverflowRowBodyProps & {
  session: IAcpSession
  service: IAcpSessionServiceType
  active: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const unionPool = useObservable(service.mcpServerDefinitions)
  const pool = filterPoolForSession(unionPool, session.agentId)
  const selection = useObservable(session.mcpServerSelection)
  // Same predicate as the inline picker's self-hide, against the same union
  // pool: a read-only session or an empty union pool leaves no row (not just no
  // value text) — there is nothing to toggle. Using the filtered pool here would
  // drop the row for a claude session that only has codex-only entries while the
  // inline trigger still shows 0/0.
  if (isMcpPickerHidden(session, unionPool)) return null
  const { enabledNames } = resolveMcpServerSelection(pool, selection)
  return (
    <OverflowRowLayout
      entryKey={MCP_ENTRY_KEY}
      icon={<Plug size={13} strokeWidth={1.75} aria-hidden="true" />}
      name={localize('acp.mcp.picker.title', 'MCP servers enabled for this session')}
      value={
        <>
          {new Set(enabledNames).size}/{pool.length}
        </>
      }
      body={
        <McpPickerPanel
          session={session}
          onRequestClose={onRequestClose}
          onAltDigit={onAltDigit}
          onExitUp={onExitUp}
          onExitDown={onExitDown}
        />
      }
      active={active}
      expanded={expanded}
      onToggle={onToggle}
    />
  )
}
