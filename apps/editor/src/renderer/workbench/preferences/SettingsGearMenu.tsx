/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Hover gear menu for a settings row (Reset / Copy ID / Copy as JSON). Built
 *  from per-row state like ExtensionActionsMenu, anchored at the click point.
 *--------------------------------------------------------------------------------------------*/

import { AnchoredSurface } from '@universe-editor/workbench-ui'
import { localize } from '@universe-editor/platform'
import styles from './SettingsEditor.module.css'

export interface SettingsGearMenuState {
  readonly x: number
  readonly y: number
  readonly configKey: string
  readonly value: unknown
  readonly canReset: boolean
  readonly onReset: () => void
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text)
}

export function SettingsGearMenu({
  state,
  onClose,
}: {
  state: SettingsGearMenuState
  onClose: () => void
}) {
  return (
    <AnchoredSurface x={state.x} y={state.y} onClose={onClose}>
      <ul role="menu" className={styles['menu']}>
        <li
          role="menuitem"
          aria-disabled={!state.canReset || undefined}
          className={state.canReset ? styles['menuItem'] : styles['menuItemDisabled']}
          onClick={() => {
            if (!state.canReset) return
            onClose()
            state.onReset()
          }}
        >
          {localize('settings.gear.reset', 'Reset Setting')}
        </li>
        <li
          role="menuitem"
          className={styles['menuItem']}
          onClick={() => {
            onClose()
            copyText(state.configKey)
          }}
        >
          {localize('settings.gear.copyId', 'Copy Setting ID')}
        </li>
        <li
          role="menuitem"
          className={styles['menuItem']}
          onClick={() => {
            onClose()
            copyText(JSON.stringify({ [state.configKey]: state.value }, null, 2))
          }}
        >
          {localize('settings.gear.copyJson', 'Copy Setting as JSON')}
        </li>
      </ul>
    </AnchoredSurface>
  )
}
