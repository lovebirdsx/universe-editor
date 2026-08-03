/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  McpEnablementToggles — the per-server default on/off switches for MCP
 *  servers, shared by the session MCP picker (compact) and the AI settings
 *  MCP panel. Two independent switches backed by IMcpServerEnablementService:
 *
 *    • User level (User icon) — the default for every workspace. Only shown
 *      for names with a user-level definition (`showUserToggle`), since a
 *      workspace-only name has nothing global to govern.
 *    • Workspace level (Folder icon) — the override for the open folder,
 *      which wins. Three-state: indeterminate = inherit (no record), and the
 *      click cycles inherit → enabled → disabled → inherit (the last step
 *      drops the record via removeOverride).
 *
 *  The user-level switch always shows the user-level STANCE (default: on),
 *  never the effective value — otherwise a workspace override would make the
 *  switch look like it bounced back after being clicked. The divergence is
 *  surfaced in the tooltip instead.
 *--------------------------------------------------------------------------------------------*/

import { useCallback } from 'react'
import { Folder, User } from 'lucide-react'
import { localize, StorageScope } from '@universe-editor/platform'
import { Checkbox, cx } from '@universe-editor/workbench-ui'
import { useEventValue, useService } from '../useService.js'
import { IMcpServerEnablementService } from '../../services/acp/mcpServerEnablementService.js'
import styles from './agents.module.css'

export function McpEnablementToggles({
  name,
  showUserToggle,
  compact = false,
  disabled = false,
}: {
  readonly name: string
  readonly showUserToggle: boolean
  readonly compact?: boolean
  readonly disabled?: boolean
}) {
  const enablement = useService(IMcpServerEnablementService)
  const getStances = useCallback(
    () => ({
      global: enablement.getOverride(name, StorageScope.GLOBAL),
      workspace: enablement.getOverride(name, StorageScope.WORKSPACE),
      effective: enablement.isEnabled(name),
    }),
    [enablement, name],
  )
  const {
    global: globalStance,
    workspace: wsStance,
    effective,
  } = useEventValue(enablement.onDidChange, getStances)

  // Shadow hint compares the DISPLAYED stance (record ?? default-on) with the
  // effective value: a workspace record can override an implicit default too.
  const userTitle =
    (globalStance ?? true) !== effective
      ? localize(
          'acp.mcp.ena.userTitleShadowed',
          'User-level default (all workspaces) — currently overridden by the workspace setting',
        )
      : localize('acp.mcp.ena.userTitle', 'User-level default (all workspaces)')
  const wsTitle =
    wsStance === undefined
      ? localize(
          'acp.mcp.ena.wsTitleInherit',
          'Workspace default (wins here) — inheriting: {state}',
          {
            state: effective
              ? localize('acp.mcp.state.enabled', 'enabled')
              : localize('acp.mcp.state.disabled', 'disabled'),
          },
        )
      : wsStance
        ? localize('acp.mcp.ena.wsTitleOn', 'Workspace default — enabled for this project')
        : localize('acp.mcp.ena.wsTitleOff', 'Workspace default — disabled for this project')

  const cycleWorkspace = (): void => {
    // Drive the state machine from the recorded stance, NOT the checkbox's
    // checked argument: clicking an indeterminate input reports checked=true,
    // which would skip the explicit-enabled step.
    if (wsStance === undefined) void enablement.setEnabled(name, true, StorageScope.WORKSPACE)
    else if (wsStance) void enablement.setEnabled(name, false, StorageScope.WORKSPACE)
    else void enablement.removeOverride(name, StorageScope.WORKSPACE)
  }

  return (
    <span className={cx(styles['mcpEnaToggles'], compact && styles['compact'])}>
      {showUserToggle && (
        <span className={styles['mcpEnaToggle']} data-tooltip={userTitle}>
          <User size={compact ? 10 : 11} strokeWidth={1.75} aria-hidden="true" />
          <Checkbox
            checked={globalStance ?? true}
            disabled={disabled}
            onChange={(v) => void enablement.setEnabled(name, v, StorageScope.GLOBAL)}
            aria-label={localize('acp.mcp.ena.userAria', 'Toggle user-level default')}
            data-testid="mcp-ena-user-toggle"
          />
        </span>
      )}
      <span className={styles['mcpEnaToggle']} data-tooltip={wsTitle}>
        <Folder size={compact ? 10 : 11} strokeWidth={1.75} aria-hidden="true" />
        <Checkbox
          checked={wsStance === true}
          indeterminate={wsStance === undefined}
          disabled={disabled}
          onChange={cycleWorkspace}
          aria-label={localize('acp.mcp.ena.wsAria', 'Toggle workspace-level default')}
          data-testid="mcp-ena-ws-toggle"
        />
      </span>
    </span>
  )
}
