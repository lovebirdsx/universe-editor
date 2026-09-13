/*---------------------------------------------------------------------------------------------
 *  AiQuickSettingsPanel — presentation-only quick-settings popover for AI features.
 *  Top: an inline-completions section with one checkbox per scope (text editor /
 *  session input) so each can be toggled independently, plus shortcut buttons
 *  (open Sessions view, open AI settings). Below: a small table mapping each AI
 *  feature slot (chat / inline / commit) to its active model; clicking a row asks
 *  the host to open that slot's model picker, so model selection stays consistent
 *  with the rest of the app.
 *
 *  Pure: data in, callbacks out. Icons are injected via `renderIcon` so the library
 *  never depends on an icon set.
 *--------------------------------------------------------------------------------------------*/

import { type ReactNode } from 'react'
import { Checkbox } from '../../atoms/Checkbox.js'
import { IconButton } from '../../atoms/IconButton.js'
import styles from './AiQuickSettingsPanel.module.css'

export type AiSlotKey = 'chat' | 'inline' | 'commit' | 'sessionTitle'

export type AiInlineScope = 'editor' | 'session'

export interface AiSlotRow {
  readonly key: AiSlotKey
  readonly label: string
  readonly currentModelName?: string | undefined
}

export interface AiInlineScopeRow {
  readonly scope: AiInlineScope
  readonly label: string
  readonly checked: boolean
}

export interface AiQuickSettingsPanelProps {
  readonly title: string
  readonly inlineLabel: string
  readonly inlineScopes: readonly AiInlineScopeRow[]
  readonly onToggleInlineScope: (scope: AiInlineScope, enabled: boolean) => void
  readonly openSessionsLabel: string
  readonly onOpenSessions: () => void
  readonly openSettingsLabel: string
  readonly onOpenAiSettings: () => void
  readonly rows: readonly AiSlotRow[]
  readonly noModelLabel: string
  readonly onPickModel: (slot: AiSlotKey) => void
  readonly renderIcon: (id: 'sessions' | 'settings') => ReactNode
}

export function AiQuickSettingsPanel({
  title,
  inlineLabel,
  inlineScopes,
  onToggleInlineScope,
  openSessionsLabel,
  onOpenSessions,
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
        <span className={styles['inlineTitle']}>{inlineLabel}</span>
        <div className={styles['actions']}>
          <IconButton
            label={openSessionsLabel}
            onClick={onOpenSessions}
            data-testid="ai-quick-settings-open-sessions"
          >
            {renderIcon('sessions')}
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

      <div className={styles['scopeList']}>
        {inlineScopes.map((s) => (
          <Checkbox
            key={s.scope}
            checked={s.checked}
            onChange={(checked) => onToggleInlineScope(s.scope, checked)}
            label={s.label}
            aria-label={s.label}
            data-testid={`ai-quick-settings-inline-toggle-${s.scope}`}
          />
        ))}
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
