/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  McpServerPicker — session-level MCP server toggle living in the prompt
 *  action row next to the config options. The trigger shows the effective
 *  "enabled / pool" count; the popover lists every definition from the merged
 *  pool (global `acp.mcpServers` + project `.mcp.json`) with a checkbox, the
 *  live connection status dot, and its source. Toggling converges the session
 *  via IAcpSessionService.setSessionMcpServers (seamless reload) and affects
 *  only this session — the default set new sessions start with is governed by
 *  each entry's per-server default switch (`disabled` flag), editable inline
 *  via the "default" toggle and in AI Settings.
 *
 *  `McpPickerPanel` is the surface-free content (all logic included) so the
 *  overflow menu can render the same list inline; the picker is just the
 *  trigger + anchored shell around it.
 *--------------------------------------------------------------------------------------------*/

import { useState, type HTMLAttributes } from 'react'
import { ChevronDown, Plug } from 'lucide-react'
import { ICommandService, localize } from '@universe-editor/platform'
import { AnchoredSurface } from '@universe-editor/workbench-ui'
import { useObservable, useOptionalService } from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../services/acp/session/acpSessionService.js'
import {
  resolveMcpServerSelection,
  type McpServerDefinition,
} from '../../services/acp/acpMcpServers.js'
import { McpEnablementToggles } from './McpEnablementToggles.js'
import styles from './agents.module.css'

/**
 * The picker (inline trigger and overflow row alike) self-hides for read-only
 * sessions — they cannot mutate the session's server set — and when the pool
 * is empty (nothing to toggle). Shared so the two hosts never drift apart.
 */
export function isMcpPickerHidden(
  session: IAcpSession,
  pool: readonly McpServerDefinition[],
): boolean {
  return session.readOnly || pool.length === 0
}

export function McpServerPicker({
  session,
  open,
  onOpen,
  onClose,
}: {
  session: IAcpSession
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  // Soft dependency: unit tests render the config bar with a minimal DI
  // container that has no ACP layer — the picker simply stays absent there.
  const service = useOptionalService(IAcpSessionService)
  if (!service) return null
  return (
    <McpServerPickerInner
      session={session}
      service={service}
      open={open}
      onOpen={onOpen}
      onClose={onClose}
    />
  )
}

function McpServerPickerInner({
  session,
  service,
  open,
  onClose,
  onOpen,
}: {
  session: IAcpSession
  service: IAcpSessionServiceType
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const pool = useObservable(service.mcpServerDefinitions)
  const selection = useObservable(session.mcpServerSelection)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  if (isMcpPickerHidden(session, pool)) return null
  // `null` (inherit) resolves to every non-disabled pool entry — the same
  // default set a brand-new session starts with.
  const { enabledNames } = resolveMcpServerSelection(pool, selection)
  const enabledSet = new Set(enabledNames)
  const custom = selection !== null
  return (
    <div className={styles['configTriggerWrap']} data-testid="acp-mcp-picker">
      <button
        type="button"
        className={styles['configTrigger']}
        data-custom={custom}
        data-testid="acp-mcp-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={localize('acp.mcp.picker.title', 'MCP servers enabled for this session')}
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
          // Pick up a `.mcp.json` edited on disk since the last refresh.
          void service.refreshMcpServerDefinitions()
          onOpen()
        }}
      >
        <Plug size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['configTriggerValue']}>
          {enabledSet.size}/{pool.length}
        </span>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
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
              className: styles['configPopover'],
              role: 'dialog',
              'aria-label': localize(
                'acp.mcp.picker.title',
                'MCP servers enabled for this session',
              ),
              'data-testid': 'acp-mcp-picker-popover',
            } as HTMLAttributes<HTMLDivElement>
          }
        >
          <McpPickerPanel session={session} onRequestClose={onClose} />
        </AnchoredSurface>
      ) : null}
    </div>
  )
}

/** Surface-free list content; renders inside any host (picker surface, overflow menu). */
export function McpPickerPanel({
  session,
  onRequestClose,
}: {
  session: IAcpSession
  /** Invoked before navigating away (e.g. opening settings) so a host surface can dismiss. */
  onRequestClose?: () => void
}) {
  // Soft dependency, same as the picker: stays absent without the ACP layer.
  const service = useOptionalService(IAcpSessionService)
  if (!service) return null
  return (
    <McpPickerPanelInner
      session={session}
      service={service}
      {...(onRequestClose !== undefined ? { onRequestClose } : {})}
    />
  )
}

function McpPickerPanelInner({
  session,
  service,
  onRequestClose,
}: {
  session: IAcpSession
  service: IAcpSessionServiceType
  onRequestClose?: () => void
}) {
  const pool = useObservable(service.mcpServerDefinitions)
  const selection = useObservable(session.mcpServerSelection)
  const liveServers = useObservable(session.mcpServers)
  const commands = useOptionalService(ICommandService)
  // `null` (inherit) resolves to every non-disabled pool entry — the same
  // default set a brand-new session starts with.
  const { enabledNames } = resolveMcpServerSelection(pool, selection)
  const enabledSet = new Set(enabledNames)
  const custom = selection !== null
  const liveStatus = new Map(liveServers.map((s) => [s.name, s.status]))
  const toggle = (name: string): void => {
    const base = selection ?? enabledNames
    const next = enabledSet.has(name) ? base.filter((n) => n !== name) : [...base, name]
    service.setSessionMcpServers(session.id, next)
  }
  return (
    <>
      <div className={styles['mcpPickHeader']}>
        <span>
          {custom
            ? localize('acp.mcp.picker.custom', 'Custom selection')
            : localize('acp.mcp.picker.inherit', 'Following defaults')}
        </span>
        {custom ? (
          <button
            type="button"
            data-testid="acp-mcp-picker-reset"
            onClick={() => service.setSessionMcpServers(session.id, null)}
          >
            {localize('acp.mcp.picker.reset', 'Reset')}
          </button>
        ) : null}
      </div>
      {pool.map((def) => (
        <div
          key={def.name}
          className={styles['mcpPickRow']}
          data-status={liveStatus.get(def.name)}
          data-testid="acp-mcp-picker-row"
          data-name={def.name}
        >
          <label className={styles['mcpPickSession']}>
            <input
              type="checkbox"
              checked={enabledSet.has(def.name)}
              onChange={() => toggle(def.name)}
            />
            {liveStatus.has(def.name) ? (
              <span className={styles['mcpStatusDot']} aria-hidden="true" />
            ) : null}
            <span
              className={styles['mcpPickName']}
              data-default-disabled={def.disabled || undefined}
            >
              {def.name}
            </span>
            <span className={styles['mcpPickMeta']}>
              {def.fromMcpJson
                ? '.mcp.json'
                : def.source === 'project'
                  ? localize('acp.mcp.picker.sourceProject', 'project')
                  : def.source === 'extension'
                    ? localize('acp.mcp.picker.sourceExtension', 'extension')
                    : localize('acp.mcp.picker.sourceGlobal', 'global')}
            </span>
          </label>
          <McpEnablementToggles
            name={def.name}
            showUserToggle={def.hasUserLevelDefinition ?? false}
            compact
          />
        </div>
      ))}
      <div className={styles['mcpPickFooter']}>
        <button
          type="button"
          data-testid="acp-mcp-picker-open-settings"
          onClick={() => {
            onRequestClose?.()
            void commands?.executeCommand('workbench.action.agent.openMcpSettings')
          }}
        >
          {localize('acp.mcp.picker.openSettings', 'Configure MCP servers…')}
        </button>
      </div>
      <div className={styles['mcpPickHint']}>
        {localize(
          'acp.mcp.picker.cacheHint',
          'Changing servers restarts the session and invalidates the model prompt cache.',
        )}{' '}
        {localize(
          'acp.mcp.picker.defaultHint',
          'Checkboxes on the left apply to this session only; the person/folder switches set the user-level and workspace-level defaults (workspace wins, and can go back to inheriting).',
        )}
      </div>
    </>
  )
}
