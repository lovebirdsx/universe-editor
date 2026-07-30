/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for PermissionCard — focuses on the ExitPlanMode ("Ready to code?")
 *  steering input: typing an instruction and submitting must reject the plan
 *  (keep planning) AND pass the text as `feedback` on resolve (so the fork can
 *  surface it as a replayable deny message). Non-plan permission cards must not
 *  render the input at all. Also covers the plan auto-execute toggle +
 *  interruptible countdown (acp.plan.autoExecute).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  InstantiationService,
  observableValue,
  ServiceCollection,
  type IConfigurationChangeEvent,
} from '@universe-editor/platform'
import type {
  AcpPendingPermission,
  IAcpSession,
} from '../../../services/acp/session/acpSessionService.js'
import { ServicesContext } from '../../useService.js'
import { PermissionCard } from '../PermissionCard.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function planPermission(overrides?: Partial<AcpPendingPermission>): AcpPendingPermission {
  return {
    toolCallId: 't1',
    title: 'Ready to code?',
    kind: 'switch_mode',
    options: [
      { optionId: 'default', name: 'Yes, and manually approve edits', kind: 'allow_once' },
      { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
    ],
    resolve: () => {},
    cancel: () => {},
    ...overrides,
  }
}

/** plan options mirroring the fork's ExitPlanMode order (bypass first). */
function forkPlanOptions(): AcpPendingPermission['options'] {
  return [
    { optionId: 'bypassPermissions', name: 'Yes, and bypass permissions', kind: 'allow_always' },
    { optionId: 'default', name: 'Yes, and manually approve edits', kind: 'allow_once' },
    { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
  ]
}

function bashPermission(): AcpPendingPermission {
  return {
    toolCallId: 't2',
    title: 'Run `ls`',
    kind: 'execute',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    resolve: () => {},
    cancel: () => {},
  }
}

function makeConfig(initial?: Record<string, unknown>): {
  config: IConfigurationService
  store: Map<string, unknown>
} {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}))
  const emitter = new Emitter<IConfigurationChangeEvent>()
  const config = {
    _serviceBrand: undefined,
    get: (key: string) => store.get(key),
    update: (key: string, value: unknown) => {
      store.set(key, value)
      emitter.fire({ affectsConfiguration: (k: string) => k === key })
    },
    onDidChangeConfiguration: emitter.event,
  } as unknown as IConfigurationService
  return { config, store }
}

function renderCard(
  pending: AcpPendingPermission,
  initialConfig?: Record<string, unknown>,
): { store: Map<string, unknown> } {
  const { config, store } = makeConfig(initialConfig)
  const services = new ServiceCollection()
  services.set(IConfigurationService, config)
  const inst = new InstantiationService(services)
  const obs = observableValue<AcpPendingPermission | undefined>('pp:A', undefined)
  // Mirror the service's settle: resolve/cancel clears pendingPermission, which
  // unmounts the card (and tears down the countdown effect with it).
  const wrapped: AcpPendingPermission = {
    ...pending,
    resolve: (optionId, feedback) => {
      if (feedback === undefined) pending.resolve(optionId)
      else pending.resolve(optionId, feedback)
      obs.set(undefined, undefined)
    },
    cancel: () => {
      pending.cancel()
      obs.set(undefined, undefined)
    },
  }
  obs.set(wrapped, undefined)
  const session = {
    id: 'A',
    pendingPermission: obs,
    sendPrompt: vi.fn(() => Promise.resolve()),
  } as unknown as IAcpSession
  render(
    <ServicesContext.Provider value={inst}>
      <PermissionCard session={session} />
    </ServicesContext.Provider>,
  )
  return { store }
}

function toggle(): HTMLInputElement {
  return screen.getByTestId('acp-permission-auto-execute') as HTMLInputElement
}

describe('PermissionCard steering (ExitPlanMode)', () => {
  it('rejects the plan and passes the typed instruction as feedback on resolve', () => {
    const resolve = vi.fn()
    renderCard(planPermission({ resolve }))

    const input = screen.getByTestId('acp-permission-steer-input')
    fireEvent.change(input, { target: { value: '  use a worker pool instead  ' } })
    fireEvent.click(screen.getByTestId('acp-permission-steer-submit'))

    expect(resolve).toHaveBeenCalledWith('plan', 'use a worker pool instead')
  })

  it('submits on Enter (without Shift)', () => {
    const resolve = vi.fn()
    renderCard(planPermission({ resolve }))

    const input = screen.getByTestId('acp-permission-steer-input')
    fireEvent.change(input, { target: { value: 'rethink the schema' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(resolve).toHaveBeenCalledWith('plan', 'rethink the schema')
  })

  it('does not submit empty / whitespace-only input', () => {
    const resolve = vi.fn()
    renderCard(planPermission({ resolve }))

    const input = screen.getByTestId('acp-permission-steer-input')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('acp-permission-steer-submit'))

    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not render the steering input for a non-plan permission', () => {
    renderCard(bashPermission())
    expect(screen.queryByTestId('acp-permission-steer-input')).toBeNull()
  })
})

describe('PermissionCard auto-execute (acp.plan.autoExecute)', () => {
  function autoPending(resolve: ReturnType<typeof vi.fn>): AcpPendingPermission {
    return planPermission({
      resolve,
      options: forkPlanOptions(),
      autoResolve: { optionId: 'bypassPermissions', delayMs: 100 },
    })
  }

  it('renders bypass (allow_always) as the first action on the plan review card', () => {
    renderCard(planPermission({ options: forkPlanOptions() }))
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]!.getAttribute('data-testid')).toBe('acp-permission-allow-always')
    expect(buttons[0]!.textContent).toBe('Yes, and bypass permissions')
  })

  it('keeps the minimal grant (allow_once) first on ordinary tool cards', () => {
    renderCard(bashPermission())
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]!.textContent).toBe('Allow')
    expect(buttons[1]!.textContent).toBe('Reject')
  })

  it('auto-resolves the configured option once the countdown elapses', () => {
    vi.useFakeTimers()
    const resolve = vi.fn()
    renderCard(autoPending(resolve), { 'acp.plan.autoExecute': 'bypassPermissions' })

    expect(resolve).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(resolve).toHaveBeenCalledWith('bypassPermissions')
  })

  it('pauses the countdown while the card is hovered', () => {
    vi.useFakeTimers()
    const resolve = vi.fn()
    renderCard(autoPending(resolve), { 'acp.plan.autoExecute': 'bypassPermissions' })

    const card = screen.getByTestId('acp-permission-card')
    fireEvent.mouseEnter(card)
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(resolve).not.toHaveBeenCalled()

    fireEvent.mouseLeave(card)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(resolve).toHaveBeenCalledWith('bypassPermissions')
  })

  it('does not auto-resolve again after a manual choice settles the card', () => {
    vi.useFakeTimers()
    const resolve = vi.fn()
    renderCard(autoPending(resolve), { 'acp.plan.autoExecute': 'bypassPermissions' })

    fireEvent.click(screen.getByTestId('acp-permission-deny'))
    expect(resolve).toHaveBeenCalledWith('plan')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('checking the toggle writes bypassPermissions to the setting', () => {
    const { store } = renderCard(planPermission())
    expect(toggle().checked).toBe(false)

    fireEvent.click(toggle())
    expect(store.get('acp.plan.autoExecute')).toBe('bypassPermissions')
    expect(toggle().checked).toBe(true)
  })

  it('reflects any non-off setting value as checked', () => {
    renderCard(planPermission(), { 'acp.plan.autoExecute': 'acceptEdits' })
    expect(toggle().checked).toBe(true)
  })

  it('unchecking the toggle writes off and cancels the in-flight countdown', () => {
    vi.useFakeTimers()
    const resolve = vi.fn()
    const { store } = renderCard(autoPending(resolve), {
      'acp.plan.autoExecute': 'bypassPermissions',
    })

    fireEvent.click(toggle())
    expect(store.get('acp.plan.autoExecute')).toBe('off')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not render the toggle for a non-plan permission', () => {
    renderCard(bashPermission())
    expect(screen.queryByTestId('acp-permission-auto-execute')).toBeNull()
  })
})
