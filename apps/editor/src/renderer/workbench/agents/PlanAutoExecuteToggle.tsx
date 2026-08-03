/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PlanAutoExecuteToggle — the "Auto-execute future plans" checkbox shared by
 *  the plan review card (PermissionCard) and the plan-mode question card
 *  (ElicitationCard). Mirrors `acp.plan.autoExecute`: checked ⟺ setting ≠ off;
 *  checking writes 'bypassPermissions' (other modes selectable in Settings),
 *  unchecking writes 'off'. Both cards stay in sync via the config change event.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { ConfigurationTarget, IConfigurationService, localize } from '@universe-editor/platform'
import { useService } from '../useService.js'
import styles from './agents.module.css'

export const AUTO_EXECUTE_SETTING = 'acp.plan.autoExecute'

export function PlanAutoExecuteToggle({
  onUnchecked,
  testId = 'acp-permission-auto-execute',
}: {
  /** Fired when the user unchecks — lets a host card void an in-flight countdown. */
  onUnchecked?: () => void
  testId?: string
}) {
  const config = useService(IConfigurationService)
  const [enabled, setEnabled] = useState(() => {
    const mode = config.get<string>(AUTO_EXECUTE_SETTING)
    return !!mode && mode !== 'off'
  })
  useEffect(() => {
    const sub = config.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(AUTO_EXECUTE_SETTING)) return
      const mode = config.get<string>(AUTO_EXECUTE_SETTING)
      setEnabled(!!mode && mode !== 'off')
    })
    return () => sub.dispose()
  }, [config])

  return (
    <label
      className={styles['permissionAutoToggle']}
      data-tooltip={localize(
        'acp.permission.autoExecute.tooltip',
        'When a plan finishes, continue automatically after a short countdown. Choose the mode in setting acp.plan.autoExecute.',
      )}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => {
          config.update(
            AUTO_EXECUTE_SETTING,
            e.target.checked ? 'bypassPermissions' : 'off',
            ConfigurationTarget.User,
          )
          if (!e.target.checked) onUnchecked?.()
        }}
        data-testid={testId}
      />
      <span>{localize('acp.permission.autoExecute', 'Auto-execute future plans')}</span>
    </label>
  )
}
