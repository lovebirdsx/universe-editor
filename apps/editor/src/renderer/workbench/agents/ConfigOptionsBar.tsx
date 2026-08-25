/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigOptionsBar — compact icon-button row of session-level switches
 *  (model / mode / thought level / custom / sub agent / MCP). Sits inline with
 *  the Send button inside PromptInput's action row. Clicking a trigger opens a
 *  small popover for choosing a value.
 *
 *  The bar is a single line: entry order is the single source of truth in
 *  services/acp/configBarLayout.ts (model… → subagent → mode → thought_level →
 *  custom… → mcp), and when there is not enough width the low-priority tail
 *  moves into the "…" overflow panel (ConfigBarOverflowMenu) instead of
 *  wrapping onto a second line. useConfigBarOverflow measures the line; the
 *  inline popover and the overflow panel are mutually exclusive so
 *  SubagentModelPanel's local state never mounts twice.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useState, type HTMLAttributes } from 'react'
import { Bot, ChevronDown, Settings2, Sliders, Sparkles } from 'lucide-react'
import {
  IDialogService,
  INotificationService,
  Severity,
  constObservable,
  localize,
} from '@universe-editor/platform'
import { AnchoredSurface } from '@universe-editor/workbench-ui'
import { useObservable, useOptionalService, useService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import type { McpServerDefinition } from '../../services/acp/acpMcpServers.js'
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import { findConfigOptionLabel } from '../../services/acp/configOptionLabel.js'
import {
  buildConfigBarEntries,
  compareByCategory,
  MCP_ENTRY_KEY,
  SUBAGENT_ENTRY_KEY,
} from '../../services/acp/configBarLayout.js'
import {
  confirmModelSwitchContextShrink,
  evaluateModelSwitchContextShrink,
} from '../../services/acp/session/modelSwitchContextGuard.js'
import { ConfigBarOverflowMenu } from './ConfigBarOverflowMenu.js'
import { isMcpPickerHidden, McpServerPicker } from './McpServerPicker.js'
import { SubagentModelPicker } from './SubagentModelPicker.js'
import { useConfigBarOverflow } from './useConfigBarOverflow.js'
import styles from './agents.module.css'

// Fallback for the soft ACP dependency: without the session service (unit
// tests) there is no pool observable to read, so the hook count stays fixed
// by reading from this constant instead.
const EMPTY_MCP_POOL = constObservable<readonly McpServerDefinition[]>([])

export { findConfigOptionLabel as findLabel }
export { compareByCategory }

export function ConfigOptionsBar({ session }: { session: IAcpSession }) {
  const options = useObservable(session.configOptions)
  const service = useOptionalService(IAcpSessionService)
  const pool = useObservable(service?.mcpServerDefinitions ?? EMPTY_MCP_POOL)
  const [openId, setOpenId] = useState<string | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const entries = buildConfigBarEntries(options, {
    includeSubagent: session.agentId === 'claude-code',
    includeMcp: !isMcpPickerHidden(session, pool),
  })
  const { itemsRef, overflowRef, entryRefFor, overflowedKeys } = useConfigBarOverflow(entries)

  // The inline popover and the overflow panel are mutually exclusive: the
  // sub-agent panel keeps local `changed`/`pendingWrite` state, so its two
  // hosts must never mount it at the same time.
  const openInline = (key: string) => {
    setOverflowOpen(false)
    setOpenId(key)
  }
  const openOverflow = () => {
    setOpenId(null)
    setOverflowOpen(true)
  }
  const closeInline = () => setOpenId(null)

  useLayoutEffect(() => {
    if (openId !== null && overflowedKeys.has(openId)) setOpenId(null)
    if (overflowOpen && overflowedKeys.size === 0) setOverflowOpen(false)
  }, [openId, overflowOpen, overflowedKeys])

  return (
    <div className={styles['configBar']} data-testid="acp-config-options">
      <div
        className={styles['configBarItems']}
        data-testid="acp-config-options-items"
        ref={itemsRef}
      >
        {entries.map((entry) => {
          // Overflowed entries stay mounted — hidden via CSS outside the flex
          // line — so their natural offsetWidth keeps feeding the measurement.
          const overflowed = overflowedKeys.has(entry.key)
          return (
            <div
              key={entry.key}
              className={styles['configBarEntry']}
              data-entry-key={entry.key}
              ref={entryRefFor(entry.key)}
              data-overflowed={overflowed ? 'true' : undefined}
              inert={overflowed ? true : undefined}
              aria-hidden={overflowed ? 'true' : undefined}
            >
              {entry.kind === 'option' ? (
                <ConfigOptionTrigger
                  session={session}
                  option={entry.option}
                  open={openId === entry.key}
                  onOpen={() => openInline(entry.key)}
                  onClose={closeInline}
                />
              ) : entry.kind === 'subagent' ? (
                <SubagentModelPicker
                  session={session}
                  open={openId === SUBAGENT_ENTRY_KEY}
                  onOpen={() => openInline(SUBAGENT_ENTRY_KEY)}
                  onClose={closeInline}
                />
              ) : (
                <McpServerPicker
                  session={session}
                  open={openId === MCP_ENTRY_KEY}
                  onOpen={() => openInline(MCP_ENTRY_KEY)}
                  onClose={closeInline}
                />
              )}
            </div>
          )
        })}
        <ConfigBarOverflowMenu
          session={session}
          entries={entries}
          overflowedKeys={overflowedKeys}
          open={overflowOpen}
          onOpen={openOverflow}
          onClose={() => setOverflowOpen(false)}
          buttonRef={overflowRef}
        />
      </div>
    </div>
  )
}

export function categoryIcon(category: SessionConfigOption['category']) {
  switch (category) {
    case 'model':
      return Bot
    case 'mode':
      return Settings2
    case 'thought_level':
      return Sparkles
    default:
      return Sliders
  }
}

/**
 * Apply a select pick to the session, guarded by the model-switch
 * context-shrink confirmation. Shared with the overflow menu so both entry
 * renderers apply picks identically.
 */
export async function pickConfigValue(
  session: IAcpSession,
  option: SessionConfigOption & { type: 'select' },
  value: string,
  dialogService: IDialogService,
  notificationService: INotificationService,
): Promise<void> {
  if (value === option.currentValue) return
  // Switching a large session onto a smaller-context model silently
  // compacts it on the next prompt — confirm before applying.
  if (option.category === 'model') {
    const shrink = evaluateModelSwitchContextShrink(session.agentId, session.usage.get(), value)
    if (shrink) {
      const label = findConfigOptionLabel(option.options, value)
      const ok = await confirmModelSwitchContextShrink(dialogService, shrink, label)
      if (!ok) return
    }
  }
  // Applying can reject — most visibly when the session was asleep and waking
  // its agent back up failed. Without this the popover would just close and
  // the value silently snap back, so surface the reason.
  try {
    await session.setConfigOption(option.id, value)
  } catch (err) {
    notificationService.notify({
      severity: Severity.Error,
      message: localize('agent.configOption.failed', 'Failed to apply option: {error}', {
        error: (err as Error).message,
      }),
    })
  }
}

function ConfigOptionTrigger({
  session,
  option,
  open,
  onOpen,
  onClose,
}: {
  session: IAcpSession
  option: SessionConfigOption & { type: 'select' }
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const dialogService = useService(IDialogService)
  const notificationService = useService(INotificationService)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const Icon = categoryIcon(option.category)
  const currentLabel = findConfigOptionLabel(option.options, option.currentValue)
  const testKey = option.category ?? option.id
  const tooltipParts = [option.name]
  if (option.description) tooltipParts.push(option.description)
  return (
    <div className={styles['configTriggerWrap']} data-testid={`acp-config-${testKey}`}>
      <button
        type="button"
        className={styles['configTrigger']}
        data-category={option.category ?? 'custom'}
        data-testid={`acp-config-${testKey}-trigger`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={tooltipParts.join(' — ')}
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
        <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['configTriggerValue']}>{currentLabel}</span>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && anchor !== null ? (
        <ConfigOptionPopover
          option={option}
          onPick={(value) => {
            onClose()
            void pickConfigValue(session, option, value, dialogService, notificationService)
          }}
          onDismiss={onClose}
          testKey={testKey}
          x={anchor.x}
          y={anchor.y}
        />
      ) : null}
    </div>
  )
}

function ConfigOptionPopover({
  option,
  onPick,
  onDismiss,
  testKey,
  x,
  y,
}: {
  option: SessionConfigOption & { type: 'select' }
  onPick: (value: string) => void
  onDismiss: () => void
  testKey: string
  x: number
  y: number
}) {
  return (
    <AnchoredSurface
      x={x}
      y={y}
      placement="top-start"
      offset={4}
      onClose={onDismiss}
      surfaceProps={
        {
          className: styles['configPopover'],
          role: 'listbox',
          'aria-label': option.name,
          'data-testid': `acp-config-${testKey}-popover`,
        } as HTMLAttributes<HTMLDivElement>
      }
    >
      {renderPopoverItems(option.options, option.currentValue, onPick)}
    </AnchoredSurface>
  )
}

export function renderPopoverItems(
  options: readonly SessionConfigSelectOption[] | readonly SessionConfigSelectGroup[],
  current: string,
  onPick: (value: string) => void,
) {
  if (options.length === 0) return null
  const first = options[0]!
  if ('group' in first) {
    const groups = options as readonly SessionConfigSelectGroup[]
    return groups.map((g) => (
      <div key={g.group} className={styles['configPopoverGroup']}>
        <div className={styles['configPopoverGroupLabel']}>{g.name}</div>
        {g.options.map((v) => (
          <PopoverItem key={v.value} option={v} current={current} onPick={onPick} />
        ))}
      </div>
    ))
  }
  const flat = options as readonly SessionConfigSelectOption[]
  return flat.map((v) => <PopoverItem key={v.value} option={v} current={current} onPick={onPick} />)
}

function PopoverItem({
  option,
  current,
  onPick,
}: {
  option: SessionConfigSelectOption
  current: string
  onPick: (value: string) => void
}) {
  const active = option.value === current
  return (
    <div
      role="option"
      aria-selected={active}
      data-active={active}
      className={styles['configPopoverItem']}
      data-tooltip={option.description ?? option.name}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick(option.value)
      }}
    >
      <span className={styles['configPopoverItemName']}>{option.name}</span>
    </div>
  )
}
