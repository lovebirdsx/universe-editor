/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionsFilterPopover — the funnel dropdown for the AGENTS session list,
 *  modeled on VSCode's chat session filter. Four groups: sort mode (single
 *  choice), agent visibility (multi), status visibility (multi), and Reset.
 *  Selection state lives in IAcpSessionFilterService (persisted); this is a
 *  pure controlled menu with outside-click / Esc dismissal.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { localize } from '@universe-editor/platform'
import { Check } from 'lucide-react'
import { useObservable, useService } from '../useService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import {
  IAcpSessionFilterService,
  SESSION_STATUS_BUCKETS,
  type SessionSortMode,
  type SessionStatusBucket,
} from '../../services/acp/acpSessionFilterService.js'
import styles from './agents.module.css'

export interface SessionsFilterPopoverProps {
  onDismiss: () => void
}

const SORT_MODES: readonly { id: SessionSortMode; label: string }[] = [
  { id: 'created', label: localize('acp.filter.sortByCreated', 'Sort by Created') },
  { id: 'updated', label: localize('acp.filter.sortByUpdated', 'Sort by Updated') },
]

function statusLabel(bucket: SessionStatusBucket): string {
  switch (bucket) {
    case 'completed':
      return localize('acp.filter.status.completed', 'Completed')
    case 'in_progress':
      return localize('acp.filter.status.inProgress', 'In Progress')
    case 'input_needed':
      return localize('acp.filter.status.inputNeeded', 'Input Needed')
    case 'failed':
      return localize('acp.filter.status.failed', 'Failed')
  }
}

function FilterRow({
  label,
  checked,
  onClick,
}: {
  label: string
  checked: boolean
  onClick: () => void
}) {
  return (
    <li
      role="menuitemcheckbox"
      aria-checked={checked}
      className={styles['filterRow']}
      tabIndex={-1}
      onClick={onClick}
    >
      <span className={styles['filterCheck']} aria-hidden="true">
        {checked ? <Check size={13} strokeWidth={2} /> : null}
      </span>
      <span className={styles['filterLabel']}>{label}</span>
    </li>
  )
}

export function SessionsFilterPopover({ onDismiss }: SessionsFilterPopoverProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const filterService = useService(IAcpSessionFilterService)
  const registry = useService(IAcpAgentRegistry)

  const sortMode = useObservable(filterService.sortMode)
  const excludedAgents = useObservable(filterService.excludedAgentIds)
  const excludedStatuses = useObservable(filterService.excludedStatuses)
  const isDefault = useObservable(filterService.isFilterDefault)

  const agents = registry.list()

  useEffect(() => {
    const handlePointer = (ev: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      if (ev.target instanceof Node && el.contains(ev.target)) return
      onDismiss()
    }
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onDismiss()
    }
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointer)
      document.addEventListener('keydown', handleKey)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])

  return (
    <div
      ref={containerRef}
      className={styles['filterPopover']}
      data-testid="acp-sessions-filter-popover"
      role="menu"
      aria-label={localize('acp.filter.menu', 'Filter sessions')}
    >
      <ul className={styles['filterGroup']}>
        {SORT_MODES.map((m) => (
          <FilterRow
            key={m.id}
            label={m.label}
            checked={sortMode === m.id}
            onClick={() => filterService.setSortMode(m.id)}
          />
        ))}
      </ul>
      {agents.length > 0 ? (
        <ul className={styles['filterGroup']}>
          {agents.map((a) => (
            <FilterRow
              key={a.id}
              label={a.name}
              checked={!excludedAgents.has(a.id)}
              onClick={() => filterService.toggleAgent(a.id)}
            />
          ))}
        </ul>
      ) : null}
      <ul className={styles['filterGroup']}>
        {SESSION_STATUS_BUCKETS.map((bucket) => (
          <FilterRow
            key={bucket}
            label={statusLabel(bucket)}
            checked={!excludedStatuses.has(bucket)}
            onClick={() => filterService.toggleStatus(bucket)}
          />
        ))}
      </ul>
      <ul className={styles['filterGroup']}>
        <li
          role="menuitem"
          aria-disabled={isDefault}
          className={styles['filterReset']}
          data-disabled={isDefault ? 'true' : 'false'}
          tabIndex={-1}
          onClick={() => {
            if (!isDefault) filterService.resetFilters()
          }}
        >
          {localize('acp.filter.reset', 'Reset')}
        </li>
      </ul>
    </div>
  )
}
