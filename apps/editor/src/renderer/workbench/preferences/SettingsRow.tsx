/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  One settings row: modified indicator bar, `Category: Label` title,
 *  description, per-scope override hint, hover gear menu and the value control.
 *  Memoized — the parent rebuilds the flat item list on any config change, so
 *  unchanged rows must not re-render (props are kept scalar on purpose).
 *--------------------------------------------------------------------------------------------*/

import { memo, useState } from 'react'
import { Settings } from 'lucide-react'
import {
  ConfigurationTarget,
  localize,
  type IConfigurationPropertySchema,
} from '@universe-editor/platform'
import { IconButton } from '@universe-editor/workbench-ui'
import { settingDisplayTitle } from '../../services/preferences/settingsKeys.js'
import { SettingsRowControl } from './SettingsRowControl.js'
import { SettingsGearMenu, type SettingsGearMenuState } from './SettingsGearMenu.js'
import styles from './SettingsEditor.module.css'

export interface SettingsRowProps {
  readonly configKey: string
  readonly schema: IConfigurationPropertySchema
  readonly groupTitle: string
  /** Effective value as seen from the viewed target (falls back to default). */
  readonly value: unknown
  /** Which layer owns the value in the viewed scope (undefined = default). */
  readonly origin: ConfigurationTarget | undefined
  /** The scope being viewed — the modified bar tracks ownership at this layer. */
  readonly activeTarget: ConfigurationTarget.User | ConfigurationTarget.Project
  /** Layer (≠ activeTarget) that also owns this key, for the override hint. */
  readonly otherOrigin: ConfigurationTarget | undefined
  readonly onUpdate: (key: string, value: unknown) => void
}

function otherScopeLabel(origin: ConfigurationTarget): string {
  return origin === ConfigurationTarget.Project || origin === ConfigurationTarget.VSCodeWorkspace
    ? localize('settings.origin.workspace', 'Workspace')
    : localize('settings.origin.user', 'User')
}

export const SettingsRow = memo(function SettingsRow({
  configKey,
  schema,
  groupTitle,
  value,
  origin,
  activeTarget,
  otherOrigin,
  onUpdate,
}: SettingsRowProps) {
  const [menu, setMenu] = useState<SettingsGearMenuState | null>(null)

  const { category, label } = settingDisplayTitle(configKey, groupTitle)
  const modified = origin === activeTarget
  const displayValue = value ?? schema.default

  return (
    <div
      className={styles['row']}
      data-key={configKey}
      {...(modified ? { 'data-modified': 'true' } : {})}
    >
      <div className={styles['modifiedBar']} aria-hidden="true" />
      <div className={styles['rowMeta']}>
        <div className={styles['rowTitle']} data-tooltip={configKey}>
          {category ? <span className={styles['rowCategory']}>{category}: </span> : null}
          <span className={styles['rowLabel']}>{label}</span>
        </div>
        {schema.description ? <div className={styles['rowDesc']}>{schema.description}</div> : null}
        {otherOrigin !== undefined ? (
          <div className={styles['rowHint']}>
            {localize('settings.alsoModifiedIn', 'Also modified in {scope}', {
              scope: otherScopeLabel(otherOrigin),
            })}
          </div>
        ) : null}
      </div>
      <div className={styles['rowControl']}>
        <SettingsRowControl
          configKey={configKey}
          schema={schema}
          value={displayValue}
          onCommit={(v) => onUpdate(configKey, v)}
        />
      </div>
      <div className={styles['rowGear']}>
        <IconButton
          label={localize('settings.gear.label', 'More Actions')}
          size={20}
          onClick={(e) =>
            setMenu({
              x: e.clientX,
              y: e.clientY,
              configKey,
              value: displayValue,
              canReset: modified,
              onReset: () => onUpdate(configKey, undefined),
            })
          }
        >
          <Settings size={14} />
        </IconButton>
      </div>
      {menu ? <SettingsGearMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  )
})
