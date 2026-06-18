/*---------------------------------------------------------------------------------------------
 *  AiQuickSettingsPanel — presentation-only quick-settings popover for AI features.
 *  Top row: an inline-completions toggle + shortcut buttons (open Agents view, open
 *  AI settings). Below: a small table mapping each AI feature slot (chat / inline /
 *  commit) to its active model; clicking a row asks the host to open that slot's
 *  model picker (a command-palette QuickPick), so model selection stays consistent
 *  with the rest of the app.
 *
 *  Pure: data in, callbacks out. Icons are injected via `renderIcon` so the library
 *  never depends on an icon set.
 *--------------------------------------------------------------------------------------------*/

import { type ReactNode } from 'react'
import { Toggle } from '../../atoms/Toggle.js'
import { IconButton } from '../../atoms/IconButton.js'
import styles from './AiQuickSettingsPanel.module.css'

export type AiSlotKey = 'chat' | 'inline' | 'commit'

export interface AiSlotRow {
  readonly key: AiSlotKey
  readonly label: string
  readonly currentModelName?: string | undefined
}

export interface AiQuickSettingsPanelProps {
  readonly title: string
  readonly inlineLabel: string
  readonly inlineEnabled: boolean
  readonly onToggleInline: (enabled: boolean) => void
  readonly openAgentsLabel: string
  readonly onOpenAgents: () => void
  readonly openSettingsLabel: string
  readonly onOpenAiSettings: () => void
  readonly rows: readonly AiSlotRow[]
  readonly noModelLabel: string
  readonly onPickModel: (slot: AiSlotKey) => void
  readonly renderIcon: (id: 'agents' | 'settings') => ReactNode
}

export function AiQuickSettingsPanel({
  title,
  inlineLabel,
  inlineEnabled,
  onToggleInline,
  openAgentsLabel,
  onOpenAgents,
  openSettingsLabel,
  onOpenAiSettings,
  rows,
  noModelLabel,
  onPickModel,
  renderIcon,
}: AiQuickSettingsPanelProps) {
  return (
    <div
      className={styles['panel']}
      data-testid="ai-quick-settings"
      role="dialog"
      aria-label={title}
    >
      <div className={styles['header']}>
        <label className={styles['inlineToggle']}>
          <Toggle
            checked={inlineEnabled}
            onChange={onToggleInline}
            aria-label={inlineLabel}
            data-testid="ai-quick-settings-inline-toggle"
          />
          <span>{inlineLabel}</span>
        </label>
        <div className={styles['actions']}>
          <IconButton
            label={openAgentsLabel}
            onClick={onOpenAgents}
            data-testid="ai-quick-settings-open-agents"
          >
            {renderIcon('agents')}
          </IconButton>
          <IconButton
            label={openSettingsLabel}
            onClick={onOpenAiSettings}
            data-testid="ai-quick-settings-open-settings"
          >
            {renderIcon('settings')}
          </IconButton>
        </div>
      </div>

      <div className={styles['table']} role="table">
        {rows.map((row) => (
          <div key={row.key} className={styles['row']} role="row">
            <span className={styles['rowLabel']}>{row.label}</span>
            <button
              type="button"
              className={styles['modelButton']}
              onClick={() => onPickModel(row.key)}
              data-testid={`ai-quick-settings-model-${row.key}`}
            >
              {row.currentModelName ?? noModelLabel}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
