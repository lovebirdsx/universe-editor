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
 *--------------------------------------------------------------------------------------------*/

import { useRef } from 'react'
import { ChevronDown, Plug } from 'lucide-react'
import { ICommandService, localize } from '@universe-editor/platform'
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
import { usePopoverDismiss } from './usePopoverDismiss.js'
import styles from './agents.module.css'

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
  const liveServers = useObservable(session.mcpServers)
  if (session.readOnly || pool.length === 0) return null
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
    <div className={styles['configTriggerWrap']} data-testid="acp-mcp-picker">
      <button
        type="button"
        className={styles['configTrigger']}
        data-custom={custom}
        data-testid="acp-mcp-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={localize('acp.mcp.picker.title', 'MCP servers enabled for this session')}
        onClick={() => {
          if (open) {
            onClose()
          } else {
            // Pick up a `.mcp.json` edited on disk since the last refresh.
            void service.refreshMcpServerDefinitions()
            onOpen()
          }
        }}
      >
        <Plug size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['configTriggerValue']}>
          {enabledSet.size}/{pool.length}
        </span>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open ? (
        <McpPickerPopover
          session={session}
          service={service}
          pool={pool}
          enabledSet={enabledSet}
          custom={custom}
          liveStatus={liveStatus}
          onToggle={toggle}
          onDismiss={onClose}
        />
      ) : null}
    </div>
  )
}

function McpPickerPopover({
  session,
  service,
  pool,
  enabledSet,
  custom,
  liveStatus,
  onToggle,
  onDismiss,
}: {
  session: IAcpSession
  service: IAcpSessionServiceType
  pool: readonly McpServerDefinition[]
  enabledSet: ReadonlySet<string>
  custom: boolean
  liveStatus: ReadonlyMap<string, string>
  onToggle: (name: string) => void
  onDismiss: () => void
}) {
  const commands = useOptionalService(ICommandService)
  const containerRef = useRef<HTMLDivElement | null>(null)
  usePopoverDismiss(containerRef, onDismiss)
  return (
    <div
      ref={containerRef}
      className={styles['configPopover']}
      role="dialog"
      aria-label={localize('acp.mcp.picker.title', 'MCP servers enabled for this session')}
      data-testid="acp-mcp-picker-popover"
    >
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
              onChange={() => onToggle(def.name)}
            />
            {liveStatus.has(def.name) ? (
              <span className={styles['mcpStatusDot']} aria-hidden="true" />
            ) : null}
            <span className={styles['mcpPickName']}>{def.name}</span>
            <span className={styles['mcpPickMeta']}>
              {def.fromMcpJson
                ? '.mcp.json'
                : def.source === 'extension'
                  ? localize('acp.mcp.picker.sourceExtension', 'extension')
                  : def.source === 'project'
                    ? localize('acp.mcp.picker.sourceProject', 'project')
                    : localize('acp.mcp.picker.sourceGlobal', 'global')}
            </span>
          </label>
          <label
            className={styles['mcpPickDefault']}
            title={
              def.fromMcpJson || def.source === 'extension'
                ? localize('acp.mcp.picker.defaultLocked', 'This server definition is read-only')
                : localize('acp.mcp.picker.defaultTitle', 'Enabled by default for new sessions')
            }
          >
            <input
              type="checkbox"
              data-testid="acp-mcp-picker-default-toggle"
              checked={!def.disabled}
              disabled={def.fromMcpJson === true || def.source === 'extension'}
              onChange={(e) => service.setMcpServerDefaultEnabled(def.name, e.target.checked)}
            />
            <span>{localize('acp.mcp.picker.default', 'default')}</span>
          </label>
        </div>
      ))}
      <div className={styles['mcpPickFooter']}>
        <button
          type="button"
          data-testid="acp-mcp-picker-open-settings"
          onClick={() => {
            onDismiss()
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
          'Checkboxes on the left apply to this session only; the "default" toggle decides what new sessions start with.',
        )}
      </div>
    </div>
  )
}
