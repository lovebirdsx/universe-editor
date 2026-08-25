/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SubagentModelFooter — the footer of the Model config popover on claude-code
 *  sessions: a compact "Sub Agent" pick over the selected provider's candidates.
 *  The pick travels as CLAUDE_CODE_SUBAGENT_MODEL spawn env, so it only reaches a
 *  freshly spawned process; after the user changes it, a hint row appears and
 *  offers an inline restart of the agent process.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useRef, useState } from 'react'
import { INotificationService, Severity, localize } from '@universe-editor/platform'
import { AGENT_SUBSCRIPTION_AUTH } from '../../../shared/ipc/claudeConfigService.js'
import {
  candidateModelsForProtocol,
  CLAUDE_AGENT_PROTOCOL,
} from '../../services/acp/acpModelCandidates.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'
import { useClaudeConfig } from '../agentSettings/claude/useClaudeConfig.js'
import { useProviderRegistry } from '../agentSettings/useProviderRegistry.js'
import { useService } from '../useService.js'
import styles from './agents.module.css'

/** Inherit is the empty pick — `setSubagentModel(undefined)` clears every source. */
const INHERIT = ''

export function SubagentModelFooter({ session }: { session: IAcpSession }) {
  const { agentSettings, setSubagentModel } = useClaudeConfig()
  const { providers } = useProviderRegistry()
  const notifications = useService(INotificationService)
  // Silent until the user actually changes the value, so the footer stays
  // compact for everyone who only opened the popover to look.
  const [changed, setChanged] = useState(false)
  const pendingWrite = useRef<Promise<void> | undefined>(undefined)

  const provider = useMemo(
    () =>
      agentSettings.authentication && agentSettings.authentication !== AGENT_SUBSCRIPTION_AUTH
        ? providers.find((p) => p.id === agentSettings.authentication)
        : undefined,
    [agentSettings.authentication, providers],
  )
  const candidates = useMemo(
    () => candidateModelsForProtocol(provider, CLAUDE_AGENT_PROTOCOL),
    [provider],
  )
  const current = agentSettings.subagentModel
  // A stale pick the provider no longer offers must stay selectable instead of
  // vanishing while it still applies.
  const options = useMemo(
    () => (current && !candidates.includes(current) ? [current, ...candidates] : candidates),
    [candidates, current],
  )

  const pick = (value: string): void => {
    const next = value === INHERIT ? undefined : value
    if (next === current) return
    pendingWrite.current = setSubagentModel(next)
    setChanged(true)
  }

  const restart = async (): Promise<void> => {
    // The sub-agent model is spawn env, so the fresh process reads it from
    // settings.json as it spawns — the pick must have landed on disk first.
    try {
      await pendingWrite.current
    } catch (err) {
      // Restarting on a failed write would spawn against the old value, which
      // looks like the restart silently did nothing.
      notifications.notify({
        severity: Severity.Error,
        message: localize('acp.subagent.writeFailed', 'Could not save the sub-agent model: {0}', {
          0: (err as Error).message,
        }),
      })
      return
    }
    session.requestProcessRestart()
  }

  const rows = [
    {
      key: INHERIT,
      value: INHERIT,
      label: localize('acp.subagent.inherit', 'Follow main model'),
      active: current === undefined,
    },
    ...options.map((m) => ({
      key: m,
      value: m,
      label: m,
      active: m === current,
    })),
  ]

  return (
    <div data-testid="acp-subagent-footer">
      <div className={styles['configPopoverGroupLabel']}>
        {localize('acp.subagent.label', 'Sub Agent')}
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          role="option"
          aria-selected={row.active}
          data-active={row.active}
          className={styles['configPopoverItem']}
          data-tooltip={row.label}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(row.value)
          }}
        >
          <span className={styles['configPopoverItemName']}>{row.label}</span>
        </div>
      ))}
      {changed ? (
        <div className={styles['subagentFooterHint']}>
          {localize('acp.subagent.nextSession', 'Takes effect next session')} ·{' '}
          <button type="button" data-testid="acp-subagent-restart" onClick={() => void restart()}>
            {localize('acp.subagent.restartNow', 'Restart now')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
