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
  AcpAutoResolve,
  AcpAutoResolveState,
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
    requestId: 'req-1',
    toolCallId: 't1',
    title: 'Ready to code?',
    kind: 'switch_mode',
    options: [
      {
        optionId: 'exit-plan-default',
        name: 'Yes, and manually approve edits',
        kind: 'allow_once',
      },
      { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
    ],
    resolve: () => {},
    cancel: () => {},
    resolveWithSource: () => {},
    cancelWithSource: () => {},
    ...overrides,
  }
}

/**
 * Service-owned countdown stub: the timer itself is covered by the
 * AcpSessionService tests; here we only verify the card follows its state and
 * forwards pause/resume/cancel.
 */
function makeAutoResolve(
  optionId = 'exit-plan-bypass',
  delayMs = 100,
): AcpAutoResolve & {
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} {
  const state = observableValue<AcpAutoResolveState>(`auto:${optionId}`, {
    paused: false,
    remainingMs: delayMs,
    cancelled: false,
    deadlineAt: Date.now() + delayMs,
  })
  const pause = vi.fn(() => {
    state.set({ paused: true, remainingMs: delayMs, cancelled: false }, undefined)
  })
  const resume = vi.fn(() => {
    state.set(
      { paused: false, remainingMs: delayMs, cancelled: false, deadlineAt: Date.now() + delayMs },
      undefined,
    )
  })
  const cancel = vi.fn(() => {
    state.set({ paused: false, remainingMs: 0, cancelled: true }, undefined)
  })
  return { optionId, delayMs, state, pause, resume, cancel }
}

function forkPlanOptions(): AcpPendingPermission['options'] {
  return [
    {
      optionId: 'exit-plan-clear-auto',
      name: 'Yes, clear context (41% used) and use auto mode',
      kind: 'allow_always',
    },
    { optionId: 'exit-plan-auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
    { optionId: 'exit-plan-bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
    { optionId: 'exit-plan-default', name: 'Yes, and manually approve edits', kind: 'allow_once' },
    { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
  ]
}

function codexPlanOptions(): AcpPendingPermission['options'] {
  return [
    { optionId: 'implement_plan', name: 'Yes, implement this plan', kind: 'allow_once' },
    {
      optionId: 'revise_plan',
      name: 'No, and tell Codex what to do differently',
      kind: 'reject_once',
    },
  ]
}

function bashPermission(): AcpPendingPermission {
  return {
    requestId: 'req-2',
    toolCallId: 't2',
    title: 'Run `ls`',
    kind: 'execute',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    resolve: () => {},
    cancel: () => {},
    resolveWithSource: () => {},
    cancelWithSource: () => {},
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
      emitter.fire({ keys: [key], affectsConfiguration: (k: string) => k === key })
    },
    onDidChangeConfiguration: emitter.event,
  } as unknown as IConfigurationService
  return { config, store }
}

function renderCard(
  pending: AcpPendingPermission,
  initialConfig?: Record<string, unknown>,
): { store: Map<string, unknown>; unmount: () => void } {
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
  const view = render(
    <ServicesContext.Provider value={inst}>
      <PermissionCard session={session} />
    </ServicesContext.Provider>,
  )
  return { store, unmount: view.unmount }
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

    expect(resolve).toHaveBeenCalledWith('reject', 'use a worker pool instead')
  })

  it('submits on Enter (without Shift)', () => {
    const resolve = vi.fn()
    renderCard(planPermission({ resolve }))

    const input = screen.getByTestId('acp-permission-steer-input')
    fireEvent.change(input, { target: { value: 'rethink the schema' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(resolve).toHaveBeenCalledWith('reject', 'rethink the schema')
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
  function autoPending(
    resolve: ReturnType<typeof vi.fn>,
    autoResolve: AcpAutoResolve = makeAutoResolve(),
  ): AcpPendingPermission {
    return planPermission({
      resolve,
      options: forkPlanOptions(),
      autoResolve,
    })
  }

  it('按 agent 顺序展示全部计划选项，不按权限类型去重', () => {
    const options = forkPlanOptions()
    renderCard(planPermission({ options }))
    const buttons = screen.getAllByRole('button').slice(0, options.length)
    expect(buttons.map((button) => button.textContent)).toEqual(
      options.map((option) => option.name),
    )
  })

  it.each(forkPlanOptions())('点击 $optionId 时回传原始 ID', (option) => {
    const resolve = vi.fn()
    renderCard(planPermission({ options: forkPlanOptions(), resolve }))
    fireEvent.click(screen.getByRole('button', { name: option.name }))
    expect(resolve).toHaveBeenCalledExactlyOnceWith(option.optionId)
  })

  it('keeps the minimal grant (allow_once) first on ordinary tool cards', () => {
    renderCard(bashPermission())
    const buttons = screen.getAllByRole('button')
    expect(buttons[0]!.textContent).toBe('Allow')
    expect(buttons[1]!.textContent).toBe('Reject')
  })

  it('renders the countdown from the service deadline without settling on its own', () => {
    vi.useFakeTimers()
    const resolve = vi.fn()
    const auto = makeAutoResolve('exit-plan-bypass', 100)
    renderCard(autoPending(resolve, auto), { 'acp.plan.autoExecute': 'bypassPermissions' })

    expect(screen.getByTestId('acp-permission-auto-countdown').textContent).toContain('1s')
    act(() => {
      vi.advanceTimersByTime(150)
    })
    // The service owns the timer; the card must never resolve by itself.
    expect(resolve).not.toHaveBeenCalled()
    expect(auto.pause).not.toHaveBeenCalled()
  })

  it('pauses the service countdown while the card is hovered', () => {
    const resolve = vi.fn()
    const auto = makeAutoResolve()
    renderCard(autoPending(resolve, auto), { 'acp.plan.autoExecute': 'bypassPermissions' })

    const card = screen.getByTestId('acp-permission-card')
    fireEvent.mouseEnter(card)
    expect(auto.pause).toHaveBeenCalled()

    auto.pause.mockClear()
    auto.resume.mockClear()
    fireEvent.mouseLeave(card)
    expect(auto.resume).toHaveBeenCalled()
    expect(auto.pause).not.toHaveBeenCalled()
  })

  it('聚焦卡片时暂停，失焦后继续倒计时', () => {
    const resolve = vi.fn()
    const auto = makeAutoResolve()
    renderCard(autoPending(resolve, auto), { 'acp.plan.autoExecute': 'bypassPermissions' })
    const input = screen.getByTestId('acp-permission-steer-input')
    fireEvent.focusIn(input)
    expect(auto.pause).toHaveBeenCalled()
    auto.pause.mockClear()
    auto.resume.mockClear()
    fireEvent.focusOut(input, { relatedTarget: null })
    expect(auto.resume).toHaveBeenCalled()
    expect(auto.pause).not.toHaveBeenCalled()
  })

  it('unmounting the card resumes a countdown paused by hover', () => {
    const auto = makeAutoResolve()
    const { unmount } = renderCard(autoPending(vi.fn(), auto), {
      'acp.plan.autoExecute': 'bypassPermissions',
    })
    fireEvent.mouseEnter(screen.getByTestId('acp-permission-card'))
    expect(auto.pause).toHaveBeenCalledOnce()
    unmount()
    expect(auto.resume).toHaveBeenCalled()
  })

  it('hides the countdown when the service state is cancelled', () => {
    const auto = makeAutoResolve()
    renderCard(autoPending(vi.fn(), auto), { 'acp.plan.autoExecute': 'bypassPermissions' })
    act(() => auto.cancel())
    expect(screen.queryByTestId('acp-permission-auto-countdown')).toBeNull()
  })

  it('Dismiss 取消请求并清理倒计时', () => {
    const resolve = vi.fn()
    const cancel = vi.fn()
    const auto = makeAutoResolve()
    renderCard(
      { ...autoPending(resolve, auto), cancel },
      {
        'acp.plan.autoExecute': 'bypassPermissions',
      },
    )
    fireEvent.click(screen.getByTestId('acp-permission-cancel'))
    expect(cancel).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not settle again after a manual choice', () => {
    const resolve = vi.fn()
    const auto = makeAutoResolve()
    renderCard(autoPending(resolve, auto), { 'acp.plan.autoExecute': 'bypassPermissions' })

    fireEvent.click(screen.getByTestId('acp-permission-deny'))
    expect(resolve).toHaveBeenCalledWith('reject')
    vi.useFakeTimers()
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

  it('unchecking the toggle writes off and cancels the service countdown', () => {
    const resolve = vi.fn()
    const auto = makeAutoResolve()
    const { store } = renderCard(autoPending(resolve, auto), {
      'acp.plan.autoExecute': 'bypassPermissions',
    })

    fireEvent.click(toggle())
    expect(store.get('acp.plan.autoExecute')).toBe('off')
    expect(auto.cancel).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not render the toggle for a non-plan permission', () => {
    renderCard(bashPermission())
    expect(screen.queryByTestId('acp-permission-auto-execute')).toBeNull()
  })

  it('codex 形状的计划卡不渲染 steer 输入框，但保留全部选项与倒计时', () => {
    const resolve = vi.fn()
    renderCard(
      planPermission({
        resolve,
        options: codexPlanOptions(),
        autoResolve: makeAutoResolve('implement_plan'),
      }),
      { 'acp.plan.autoExecute': 'bypassPermissions' },
    )

    expect(screen.queryByTestId('acp-permission-steer-input')).toBeNull()
    expect(screen.queryByTestId('acp-permission-steer-submit')).toBeNull()
    expect(screen.getByRole('button', { name: 'Yes, implement this plan' })).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'No, and tell Codex what to do differently' }),
    ).toBeTruthy()
    expect(screen.getByTestId('acp-permission-auto-countdown')).toBeTruthy()
  })
})
