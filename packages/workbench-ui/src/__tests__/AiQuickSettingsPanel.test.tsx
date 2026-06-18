/*---------------------------------------------------------------------------------------------
 *  Tests for AiQuickSettingsPanel — the inline toggle, the Agents / AI-settings
 *  shortcut buttons, and the per-row model picker (clicking a row fires onPickModel
 *  with the row's slot key so the host can open that slot's picker command).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  AiQuickSettingsPanel,
  type AiQuickSettingsPanelProps,
} from '../feedback/aiQuickSettings/AiQuickSettingsPanel.js'

afterEach(() => {
  cleanup()
})

function renderPanel(overrides: Partial<AiQuickSettingsPanelProps> = {}) {
  const props: AiQuickSettingsPanelProps = {
    title: 'AI',
    inlineLabel: 'Inline Completions',
    inlineEnabled: true,
    onToggleInline: vi.fn(),
    openAgentsLabel: 'Open Agents',
    onOpenAgents: vi.fn(),
    openSettingsLabel: 'Manage Models',
    onOpenAiSettings: vi.fn(),
    rows: [
      { key: 'chat', label: 'Chat', currentModelName: 'Model One' },
      { key: 'inline', label: 'Inline', currentModelName: undefined },
      { key: 'commit', label: 'Commit', currentModelName: undefined },
    ],
    noModelLabel: 'Select model…',
    onPickModel: vi.fn(),
    renderIcon: () => <span>i</span>,
    ...overrides,
  }
  render(<AiQuickSettingsPanel {...props} />)
  return props
}

describe('AiQuickSettingsPanel', () => {
  it('toggles inline completions', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByTestId('ai-quick-settings-inline-toggle'))
    expect(props.onToggleInline).toHaveBeenCalledWith(false)
  })

  it('fires the shortcut callbacks', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByTestId('ai-quick-settings-open-agents'))
    fireEvent.click(screen.getByTestId('ai-quick-settings-open-settings'))
    expect(props.onOpenAgents).toHaveBeenCalled()
    expect(props.onOpenAiSettings).toHaveBeenCalled()
  })

  it('shows the current model name and the placeholder when none', () => {
    renderPanel()
    expect(screen.getByTestId('ai-quick-settings-model-chat').textContent).toBe('Model One')
    expect(screen.getByTestId('ai-quick-settings-model-inline').textContent).toBe('Select model…')
  })

  it('fires onPickModel with the row slot when a model row is clicked', () => {
    const props = renderPanel()
    fireEvent.click(screen.getByTestId('ai-quick-settings-model-commit'))
    expect(props.onPickModel).toHaveBeenCalledWith('commit')
  })
})
