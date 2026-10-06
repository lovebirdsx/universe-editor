/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PlanPermissionPanel — the "Plan permissions" category of the Claude agent
 *  settings. Owns the personal three-way switch that decides how the editor
 *  answers permission requests from a Claude session while it is in plan mode
 *  (agentSettings.claude.planPermissionPolicy).
 *
 *  Personal only: the value is read from and written to the User layer, so a
 *  workspace / project value can neither weaken nor strengthen it. The switch is
 *  baked into a session at handshake time, hence the "next new / resumed
 *  session" note.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { ConfigurationTarget, IConfigurationService, localize } from '@universe-editor/platform'
import { useService } from '../../useService.js'
import {
  PLAN_PERMISSION_POLICIES,
  PLAN_PERMISSION_POLICY_KEY,
  readPlanPermissionPolicy,
  type PlanPermissionPolicy,
} from '../../../services/acp/session/planPermissionPolicy.js'
import type { UseClaudeConfig } from './useClaudeConfig.js'
import styles from '../AgentSettingsEditor.module.css'

const POLICY_LABELS: Record<PlanPermissionPolicy, string> = {
  skip: localize('agentSettings.planPermission.skip', 'Skip (approve once)'),
  auto: localize('agentSettings.planPermission.auto', 'Auto (CLI classifier)'),
  manual: localize('agentSettings.planPermission.manual', 'Manual (ask every time)'),
}

const POLICY_DESCRIPTIONS: Record<PlanPermissionPolicy, string> = {
  skip: localize(
    'agentSettings.planPermission.skip.desc',
    'Answer each request with the one-shot "Yes" option the agent offers — it goes through once and no rule is written. The CLI\'s own plan-auto classifier is switched off, so every request reaches the editor. Shell commands, file edits, sub-agent and web/MCP requests are all included: even a command the agent flags as dangerous is let through once without asking.',
  ),
  auto: localize(
    'agentSettings.planPermission.auto.desc',
    "Let the CLI's own plan-auto classifier decide and approve; the editor approves nothing by itself and only shows what the classifier refers it. Your organization's managed policy, if it forbids auto mode, still wins — this setting cannot override it.",
  ),
  manual: localize(
    'agentSettings.planPermission.manual.desc',
    'Switch the CLI\'s plan-auto classifier off and approve nothing: every permission request shows its card. The plan-review card ("Ready to code?") keeps its own countdown, see acp.plan.autoExecute.',
  ),
}

export function PlanPermissionPanel(_props: { config: UseClaudeConfig }) {
  const configService = useService(IConfigurationService)
  const [policy, setPolicy] = useState<PlanPermissionPolicy>(() =>
    readPlanPermissionPolicy(configService),
  )

  useEffect(() => {
    setPolicy(readPlanPermissionPolicy(configService))
    const sub = configService.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(PLAN_PERMISSION_POLICY_KEY)) return
      setPolicy(readPlanPermissionPolicy(configService))
    })
    return () => sub.dispose()
  }, [configService])

  return (
    <div className={styles['panel']}>
      <section className={styles['section']}>
        <h3 className={styles['sectionTitle']}>
          {localize('agentSettings.planPermission.title', 'Plan mode permissions')}
        </h3>
        <div className={styles['desc']}>
          {localize(
            'agentSettings.planPermission.intro',
            'How the editor answers permission requests from a Claude session while it is in plan mode. Applies to the Claude agent only, and takes effect on sessions created or resumed afterwards.',
          )}
        </div>
        <div className={styles['radioGroup']} role="radiogroup">
          {PLAN_PERMISSION_POLICIES.map((value) => (
            <label
              key={value}
              className={`${styles['radioItem']} ${value === policy ? styles['radioItemActive'] : ''}`}
            >
              <input
                type="radio"
                name="planPermissionPolicy"
                value={value}
                checked={value === policy}
                onChange={() =>
                  configService.update(PLAN_PERMISSION_POLICY_KEY, value, ConfigurationTarget.User)
                }
                style={{ marginTop: 2 }}
              />
              <div className={styles['radioBody']}>
                <span className={styles['radioTitle']}>{POLICY_LABELS[value]}</span>
                <span className={styles['desc']}>{POLICY_DESCRIPTIONS[value]}</span>
              </div>
            </label>
          ))}
        </div>
        <div className={styles['desc']}>
          {localize(
            'agentSettings.planPermission.personalOnly',
            "This is a personal setting: it is read from user settings only — a workspace or project value is ignored — and it is stored in the editor's settings.json, never in ~/.claude/settings.json.",
          )}
        </div>
      </section>
    </div>
  )
}
