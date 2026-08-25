/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigBarOverflowMenu — the "…" button at the end of the single-line
 *  config bar. When the bar cannot show every entry, the low-priority tail
 *  (see configBarLayout.ts) moves into this anchored panel; each row expands
 *  inline because a nested AnchoredSurface would die from the same Escape
 *  (its window-capture handler stopPropagation()s, so both layers would close
 *  at once). The button renders even without overflow — hidden via CSS — so
 *  the overflow measurement can always reserve its width.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { ChevronRight, MoreHorizontal, Plug, Users } from 'lucide-react'
import { IDialogService, INotificationService, localize } from '@universe-editor/platform'
import { AnchoredSurface } from '@universe-editor/workbench-ui'
import { useClaudeConfig } from '../agentSettings/claude/useClaudeConfig.js'
import { useObservable, useOptionalService, useService } from '../useService.js'
import { resolveMcpServerSelection } from '../../services/acp/acpMcpServers.js'
import { findConfigOptionLabel } from '../../services/acp/configOptionLabel.js'
import { MCP_ENTRY_KEY, type ConfigBarEntry } from '../../services/acp/configBarLayout.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../services/acp/session/acpSessionService.js'
import { categoryIcon, pickConfigValue, renderPopoverItems } from './ConfigOptionsBar.js'
import { isMcpPickerHidden, McpPickerPanel } from './McpServerPicker.js'
import { SubagentModelPanel } from './SubagentModelPicker.js'
import styles from './agents.module.css'

export function ConfigBarOverflowMenu({
  session,
  entries,
  overflowedKeys,
  open,
  onOpen,
  onClose,
  buttonRef,
}: {
  session: IAcpSession
  entries: readonly ConfigBarEntry[]
  overflowedKeys: ReadonlySet<string>
  open: boolean
  onOpen: () => void
  onClose: () => void
  buttonRef: Ref<HTMLButtonElement>
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const overflowEntries = entries.filter((e) => overflowedKeys.has(e.key))
  const hasOverflow = overflowEntries.length > 0

  // A surface closed externally (Escape, outside press, overflow cleared)
  // must not reopen with a stale expanded row.
  useEffect(() => {
    if (!open) setExpandedKey(null)
  }, [open])
  // A row that leaves the overflow set unmounts while expanded; clear it so it
  // does not come back pre-expanded.
  useEffect(() => {
    setExpandedKey((key) => (key !== null && overflowedKeys.has(key) ? key : null))
  }, [overflowedKeys])

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
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: rect.left, y: rect.top })
          onOpen()
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
          surfaceProps={
            {
              className: styles['configOverflowPanel'],
              role: 'dialog',
              'aria-label': localize('acp.config.more', 'More options…'),
              'data-testid': 'acp-config-overflow-panel',
            } as HTMLAttributes<HTMLDivElement>
          }
        >
          {overflowEntries.map((entry) => (
            <OverflowRow
              key={entry.key}
              session={session}
              entry={entry}
              expanded={expandedKey === entry.key}
              onToggle={() => setExpandedKey(expandedKey === entry.key ? null : entry.key)}
              onRequestClose={onClose}
            />
          ))}
        </AnchoredSurface>
      ) : null}
    </>
  )
}

function OverflowRow({
  session,
  entry,
  expanded,
  onToggle,
  onRequestClose,
}: {
  session: IAcpSession
  entry: ConfigBarEntry
  expanded: boolean
  onToggle: () => void
  onRequestClose: () => void
}) {
  const dialogService = useService(IDialogService)
  const notificationService = useService(INotificationService)
  // The MCP row gates itself on the service/pool (its hooks must not run
  // conditionally here), so it lives in its own component.
  if (entry.kind === 'mcp') {
    return (
      <McpOverflowRow
        session={session}
        expanded={expanded}
        onToggle={onToggle}
        onRequestClose={onRequestClose}
      />
    )
  }
  let icon: ReactNode
  let name: string
  let value: ReactNode
  let body: ReactNode = null
  let bodyRole: 'listbox' | undefined
  if (entry.kind === 'option') {
    const option = entry.option
    const Icon = categoryIcon(option.category)
    icon = <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
    name = option.name
    value = findConfigOptionLabel(option.options, option.currentValue)
    body = renderPopoverItems(
      option.options,
      option.currentValue,
      (v) => void pickConfigValue(session, option, v, dialogService, notificationService),
    )
    // The expanded body holds role="option" items — give them their listbox ancestor.
    bodyRole = 'listbox'
  } else {
    icon = <Users size={13} strokeWidth={1.75} aria-hidden="true" />
    name = localize('acp.subagent.label', 'Sub Agent')
    value = <SubagentRowValue />
    body = <SubagentModelPanel session={session} />
  }
  return (
    <OverflowRowLayout
      entryKey={entry.key}
      icon={icon}
      name={name}
      value={value}
      body={body}
      bodyRole={bodyRole}
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
  bodyRole,
  expanded,
  onToggle,
}: {
  entryKey: string
  icon: ReactNode
  name: string
  value: ReactNode
  body: ReactNode
  bodyRole: 'listbox' | undefined
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className={styles['configOverflowRowWrap']}>
      <button
        type="button"
        className={styles['configOverflowRow']}
        data-entry-key={entryKey}
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
      {expanded ? (
        <div className={styles['configOverflowRowBody']} role={bodyRole}>
          {body}
        </div>
      ) : null}
    </div>
  )
}

function SubagentRowValue() {
  const { subagentModelEnv } = useClaudeConfig()
  return <>{subagentModelEnv ?? localize('acp.subagent.inherit', 'Follow main model')}</>
}

function McpOverflowRow({
  session,
  expanded,
  onToggle,
  onRequestClose,
}: {
  session: IAcpSession
  expanded: boolean
  onToggle: () => void
  onRequestClose: () => void
}) {
  // Soft dependency, like the picker itself: no ACP layer in unit tests means
  // no row at all.
  const service = useOptionalService(IAcpSessionService)
  if (!service) return null
  return (
    <McpOverflowRowInner
      session={session}
      service={service}
      expanded={expanded}
      onToggle={onToggle}
      onRequestClose={onRequestClose}
    />
  )
}

function McpOverflowRowInner({
  session,
  service,
  expanded,
  onToggle,
  onRequestClose,
}: {
  session: IAcpSession
  service: IAcpSessionServiceType
  expanded: boolean
  onToggle: () => void
  onRequestClose: () => void
}) {
  const pool = useObservable(service.mcpServerDefinitions)
  const selection = useObservable(session.mcpServerSelection)
  // Same predicate as the inline picker's self-hide: a read-only session or an
  // empty pool leaves no row (not just no value text) — no writable toggle.
  if (isMcpPickerHidden(session, pool)) return null
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
      body={<McpPickerPanel session={session} onRequestClose={onRequestClose} />}
      bodyRole={undefined}
      expanded={expanded}
      onToggle={onToggle}
    />
  )
}
