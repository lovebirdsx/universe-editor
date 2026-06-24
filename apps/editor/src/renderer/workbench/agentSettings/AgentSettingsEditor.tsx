/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentSettingsEditor — umbrella shell for per-agent settings. The left nav lists
 *  every known ACP agent (from IAcpAgentRegistry); selecting one renders the
 *  settings UI that agent contributed to the agentSettingsRegistry. Agents with no
 *  contributed UI (e.g. a bare user-defined command) show a placeholder.
 *
 *  Claude-specific settings live under ./claude and self-register; this shell is
 *  agent-agnostic.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import { IStorageService, StorageScope, localize } from '@universe-editor/platform'
import { cx } from '@universe-editor/workbench-ui'
import { useService, useObservable } from '../useService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { AgentIcon } from '../agents/agentIcon.js'
import { getAgentSettingsComponent } from './agentSettingsRegistry.js'
import styles from './AgentSettingsEditor.module.css'
import './builtinAgentSettings.js'

const ACTIVE_AGENT_KEY = 'agent.settings.activeAgentId'

export function AgentSettingsEditor() {
  const storage = useService(IStorageService)
  const registry = useService(IAcpAgentRegistry)
  const agents = registry.list()
  const defaultAgentId = useObservable(registry.defaultAgentIdObs)

  const [agentId, setAgentId] = useState<string>(defaultAgentId)
  const restoredRef = useState(() => ({ done: false }))[0]

  useEffect(() => {
    let active = true
    void storage.get<string>(ACTIVE_AGENT_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && stored && agents.some((a) => a.id === stored)) setAgentId(stored)
      if (active) restoredRef.done = true
    })
    return () => {
      active = false
    }
  }, [storage, agents, restoredRef])

  const switchAgent = useCallback(
    (next: string) => {
      if (next === agentId) return
      setAgentId(next)
      if (restoredRef.done) void storage.set(ACTIVE_AGENT_KEY, next, StorageScope.GLOBAL)
    },
    [agentId, storage, restoredRef],
  )

  const selected = agents.find((a) => a.id === agentId) ?? agents[0]
  const Settings = selected ? getAgentSettingsComponent(selected.id) : undefined

  return (
    <div className={styles['root']}>
      <nav className={styles['nav']} aria-label={localize('agentSettings.nav', 'Agents')}>
        <div className={styles['navTitle']}>
          {localize('agentSettings.title', 'Agent Settings')}
        </div>
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            className={cx(styles['navItem'], a.id === selected?.id && styles['navItemActive'])}
            aria-current={a.id === selected?.id}
            onClick={() => switchAgent(a.id)}
          >
            <AgentIcon agentId={a.id} size={16} className={styles['navIcon']} />
            <span>{a.name}</span>
          </button>
        ))}
      </nav>

      <div className={styles['content']}>
        <div className={styles['contentHeader']}>
          <h1 className={styles['contentTitle']}>{selected?.name ?? ''}</h1>
        </div>
        {Settings && selected ? (
          <Settings agentId={selected.id} />
        ) : (
          <div className={styles['body']}>
            <div className={styles['desc']}>
              {localize(
                'agentSettings.noSettings',
                'This agent has no configurable settings in the editor yet.',
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
