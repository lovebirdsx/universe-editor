/*---------------------------------------------------------------------------------------------
 *  Tests for the Overview action gates: Run now needs a runnable, confirmed,
 *  connected and not-paused trigger; the confirmation buttons only appear while
 *  their gate is open; Reveal in JSON goes through the shared reveal helper.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TriggerSummary } from '../../../../shared/triggers/types.js'
import { TriggerOverviewPanel } from '../TriggerOverviewPanel.js'
import type { TriggerManagerActions } from '../useTriggerActions.js'

afterEach(cleanup)

function summary(overrides: Partial<TriggerSummary> = {}): TriggerSummary {
  return {
    key: 'alpha',
    id: 'alpha',
    name: 'Alpha',
    workspace: 'file:///X:/workspace',
    workspaceName: 'workspace',
    sourceType: 'manual',
    source: { type: 'manual' },
    status: 'idle',
    enabled: true,
    paused: false,
    pausedAll: false,
    autoPaused: false,
    activationConfirmed: true,
    elevatedMode: false,
    elevatedModeConfirmed: false,
    approveAction: false,
    approveConfirmed: false,
    running: 0,
    queued: 0,
    consecutiveFailures: 0,
    ...overrides,
  }
}

function makeActions(): TriggerManagerActions {
  const noop = vi.fn(async () => undefined)
  return {
    runNow: vi.fn(async () => undefined),
    setPaused: vi.fn(async () => undefined),
    setAllPaused: vi.fn(async () => undefined),
    confirmActivation: noop,
    confirmElevatedMode: noop,
    confirmAutoApprove: noop,
    openConfig: noop,
    revealInJson: noop,
    showLog: noop,
  }
}

function renderPanel(value: TriggerSummary, actions = makeActions()) {
  render(<TriggerOverviewPanel summary={value} actions={actions} />)
  return actions
}

function runNowDisabled(): boolean {
  return (screen.getByTestId('trigger-manager-run-now') as HTMLButtonElement).disabled
}

describe('TriggerOverviewPanel', () => {
  it('enables Run now for a confirmed, idle trigger', () => {
    renderPanel(summary())
    expect(runNowDisabled()).toBe(false)
  })

  it.each([
    ['paused', { paused: true }],
    ['paused for all triggers', { pausedAll: true }],
    ['needing activation', { activationConfirmed: false }],
    ['needing high-privilege confirmation', { elevatedMode: true }],
    ['offline', { offline: true }],
    ['invalid', { status: 'invalid' as const }],
  ])('disables Run now when %s', (_label, overrides) => {
    renderPanel(summary(overrides))
    expect(runNowDisabled()).toBe(true)
  })

  it('shows only the confirmation buttons whose gate is open', () => {
    renderPanel(
      summary({
        activationConfirmed: false,
        elevatedMode: true,
        elevatedModeConfirmed: false,
        approveAction: true,
        approveConfirmed: false,
      }),
    )

    expect(screen.getByTestId('trigger-manager-confirm-activation')).toBeDefined()
    expect(screen.getByTestId('trigger-manager-confirm-elevated')).toBeDefined()
    expect(screen.getByTestId('trigger-manager-confirm-approve')).toBeDefined()
  })

  it('hides confirmation buttons once every gate is satisfied', () => {
    renderPanel(summary())
    expect(screen.queryByTestId('trigger-manager-confirm-activation')).toBeNull()
    expect(screen.queryByTestId('trigger-manager-confirm-elevated')).toBeNull()
    expect(screen.queryByTestId('trigger-manager-confirm-approve')).toBeNull()
  })

  it('reveals the trigger in JSON through the shared action', () => {
    const actions = renderPanel(summary())
    fireEvent.click(screen.getByTestId('trigger-manager-reveal-json'))
    expect(actions.revealInJson).toHaveBeenCalledWith(expect.objectContaining({ id: 'alpha' }))
  })
})
