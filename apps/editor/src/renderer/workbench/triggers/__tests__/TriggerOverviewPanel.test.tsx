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
    fingerprint: 'fp-alpha',
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
    openConfig: noop,
    rescan: noop,
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

  it('keeps Run now available for a paused trigger but not when all are paused', () => {
    renderPanel(summary({ paused: true, status: 'paused' }))
    expect(runNowDisabled()).toBe(false)
    expect(screen.getByTestId('trigger-manager-gate-paused')).toBeDefined()
  })

  it.each([
    ['paused for all triggers', { paused: true, pausedAll: true }],
    ['needing activation', { activationConfirmed: false }],
    ['offline', { offline: true }],
    ['invalid', { status: 'invalid' as const }],
  ])('disables Run now when %s', (_label, overrides) => {
    renderPanel(summary(overrides))
    expect(runNowDisabled()).toBe(true)
  })

  it('shows the activation button only while the trigger is unconfirmed', () => {
    renderPanel(summary({ activationConfirmed: false }))
    expect(screen.getByTestId('trigger-manager-confirm-activation')).toBeDefined()
    cleanup()
    renderPanel(summary())
    expect(screen.queryByTestId('trigger-manager-confirm-activation')).toBeNull()
  })

  it('keeps Run now available for an elevated-mode trigger and shows the warning fact', () => {
    renderPanel(summary({ elevatedMode: true }))
    expect(runNowDisabled()).toBe(false)
    expect(screen.getByTestId('trigger-manager-overview').textContent).toContain(
      'runs without per-step approval',
    )
  })

  it('reveals the trigger in JSON through the shared action', () => {
    const actions = renderPanel(summary())
    fireEvent.click(screen.getByTestId('trigger-manager-reveal-json'))
    expect(actions.revealInJson).toHaveBeenCalledWith(expect.objectContaining({ id: 'alpha' }))
  })
})
