/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  UsageIndicator tests — the gating table rendered:
 *    - subscription snapshot → tightest window's remaining percentage
 *    - account usage → the provider-declared account number
 *    - neither → nothing
 *    - stale snapshot → dimmed, with the cutoff time in the tooltip
 *    - codex reset credit → confirm dialog, then one outcome toast per branch
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  IDialogService,
  INotificationService,
  InstantiationService,
  observableValue,
  ServiceCollection,
  Severity,
  type AiAccountUsage,
  type IDialogService as IDialogServiceType,
  type INotificationService as INotificationServiceType,
  type ISettableObservable,
} from '@universe-editor/platform'
import { UsageIndicator } from '../UsageIndicator.js'
import { ServicesContext } from '../../useService.js'
import {
  ISubscriptionUsageService,
  type ISubscriptionUsageService as ISubscriptionUsageServiceType,
  type ResetCreditOutcome,
} from '../../../services/usage/SubscriptionUsageService.js'
import { IAccountUsageService } from '../../../services/usage/AccountUsageService.js'
import type {
  AccountUsageState,
  SubscriptionUsageSnapshot,
} from '../../../services/usage/subscriptionUsage.js'
import type { IAcpSession } from '../../../services/acp/session/acpSessionService.js'

afterEach(() => cleanup())

const FETCHED_AT = 1_700_000_000_000

function snapshot(overrides: Partial<SubscriptionUsageSnapshot> = {}): SubscriptionUsageSnapshot {
  return {
    agentId: 'codex',
    planLabel: 'plus',
    windows: [
      { id: 'a', label: '5-hour', usedPercent: 12, resetsAt: FETCHED_AT + 3_600_000 },
      { id: 'b', label: 'Weekly', usedPercent: 76 },
    ],
    fetchedAt: FETCHED_AT,
    ...overrides,
  }
}

interface Harness {
  readonly snapshotObs: ISettableObservable<SubscriptionUsageSnapshot | undefined>
  readonly refresh: ReturnType<typeof vi.fn>
  readonly accountRefresh: ReturnType<typeof vi.fn>
  readonly consumeResetCredit: ReturnType<typeof vi.fn>
  readonly confirm: ReturnType<typeof vi.fn>
  readonly notify: ReturnType<typeof vi.fn>
}

function renderIndicator(options: {
  agentId?: string
  /** Host the session's agent runs on — credentials, and so usage, are per host. */
  authority?: string
  snapshot?: SubscriptionUsageSnapshot | undefined
  stale?: boolean
  account?: AccountUsageState
  confirmed?: boolean
  outcome?: ResetCreditOutcome
}): Harness {
  const snapshotObs = observableValue<SubscriptionUsageSnapshot | undefined>(
    'snapshot',
    options.snapshot,
  )
  const refresh = vi.fn().mockResolvedValue(undefined)
  const consumeResetCredit = vi.fn().mockResolvedValue(options.outcome ?? 'reset')
  const subscription = {
    _serviceBrand: undefined,
    snapshotFor: () => snapshotObs,
    refresh,
    isStale: () => options.stale === true,
    consumeResetCredit,
  } as unknown as ISubscriptionUsageServiceType

  const accountObs = observableValue<AccountUsageState>(
    'account',
    options.account ?? { hasSource: false },
  )
  const accountRefresh = vi.fn().mockResolvedValue(undefined)
  const account = {
    _serviceBrand: undefined,
    stateFor: () => accountObs,
    refresh: accountRefresh,
  }

  const confirm = vi
    .fn()
    .mockResolvedValue({ confirmed: options.confirmed !== false, choice: 'primary' })
  const notify = vi.fn().mockReturnValue({ close: () => {}, updateMessage: () => {} })

  const services = new ServiceCollection()
  services.set(ISubscriptionUsageService, subscription)
  services.set(IAccountUsageService, account as never)
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm,
    prompt: vi.fn(),
  } as unknown as IDialogServiceType)
  services.set(INotificationService, {
    _serviceBrand: undefined,
    notify,
  } as unknown as INotificationServiceType)
  const inst = new InstantiationService(services)

  const session = {
    agentId: options.agentId ?? 'codex',
    authority: options.authority,
  } as unknown as IAcpSession
  render(<UsageIndicator session={session} />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { snapshotObs, refresh, accountRefresh, consumeResetCredit, confirm, notify }
}

describe('UsageIndicator — collapsed form', () => {
  it("shows the tightest window's remaining percentage", () => {
    renderIndicator({ snapshot: snapshot() })
    expect(screen.getByTestId('acp-usage-indicator').textContent).toBe('24%')
  })

  it('spells out the remaining reading in the tooltip', () => {
    renderIndicator({ snapshot: snapshot() })
    expect(screen.getByTestId('acp-usage-indicator').getAttribute('data-tooltip')).toContain(
      '24% left',
    )
  })

  it('refreshes on mount so a just-opened chat is not showing yesterday', () => {
    const { refresh } = renderIndicator({ snapshot: snapshot() })
    expect(refresh).toHaveBeenCalledWith('codex', undefined)
  })

  it("asks about the session's own host, not the window's", () => {
    // A remote session bills against the remote host's credentials; passing the
    // window's authority (or none) would read the wrong account's quota.
    const { refresh, accountRefresh } = renderIndicator({
      snapshot: snapshot(),
      authority: 'ssh-remote+box',
    })
    expect(refresh).toHaveBeenCalledWith('codex', 'ssh-remote+box')
    expect(accountRefresh).toHaveBeenCalledWith('codex', 'ssh-remote+box')
  })

  it('dims a stale reading and puts the cutoff time in the tooltip', () => {
    renderIndicator({ snapshot: snapshot(), stale: true })
    const button = screen.getByTestId('acp-usage-indicator')
    expect(button.getAttribute('data-stale')).toBe('true')
    expect(button.getAttribute('data-tooltip')).toContain(new Date(FETCHED_AT).toLocaleString())
  })

  it('hides itself when neither readout applies', () => {
    renderIndicator({ agentId: 'claude-code', snapshot: undefined })
    expect(screen.queryByTestId('acp-usage-indicator')).toBeNull()
  })
})

describe('UsageIndicator — popover', () => {
  it('lists one bar per window and forces a fresh read on open', () => {
    const { refresh } = renderIndicator({ snapshot: snapshot() })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))

    expect(screen.getAllByTestId('acp-usage-window')).toHaveLength(2)
    expect(screen.getByTestId('acp-usage-popover').textContent).toContain('plus')
    expect(refresh).toHaveBeenCalledWith('codex', undefined, { force: true })
  })

  it('closes on Escape', async () => {
    renderIndicator({ snapshot: snapshot() })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))
    expect(screen.queryByTestId('acp-usage-popover')).not.toBeNull()

    // The dismiss listeners are armed inside a rAF so the opening click cannot
    // immediately close the popover again.
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' })
    })
    expect(screen.queryByTestId('acp-usage-popover')).toBeNull()
  })

  it('offers no reset button when the agent reports no credits at all', () => {
    renderIndicator({ snapshot: snapshot() })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))
    expect(screen.queryByTestId('acp-usage-reset-credit')).toBeNull()
  })

  it('disables the reset button when the balance is zero', () => {
    renderIndicator({ snapshot: snapshot({ resetCredits: { availableCount: 0 } }) })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))
    expect(screen.getByTestId<HTMLButtonElement>('acp-usage-reset-credit').disabled).toBe(true)
  })

  it("shows each window's remaining percentage with a matching bar", () => {
    renderIndicator({ snapshot: snapshot() })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))

    const rows = screen.getAllByTestId('acp-usage-window')
    // fixture windows: 5-hour used 12 → 88 left, Weekly used 76 → 24 left
    expect(rows[0]?.textContent).toContain('88%')
    expect(rows[1]?.textContent).toContain('24%')
    const fillOf = (row: HTMLElement) => {
      const fill = Array.from(row.querySelectorAll('span')).find((el) =>
        el.getAttribute('style')?.includes('width'),
      )
      return fill?.getAttribute('style') ?? ''
    }
    expect(fillOf(rows[0] as HTMLElement)).toContain('width: 88%')
    expect(fillOf(rows[1] as HTMLElement)).toContain('width: 24%')
  })

  it('shows the soonest credit expiry next to the reset-credit balance', () => {
    // The popover's clock is real Date.now(), so the fixture must be too.
    renderIndicator({
      snapshot: snapshot({
        resetCredits: { availableCount: 2, earliestExpiresAt: Date.now() + 3 * 86_400_000 },
      }),
    })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))
    expect(screen.getByTestId('acp-usage-popover').textContent).toContain('expires in 3d')
  })

  it('marks an already-expired credit', () => {
    renderIndicator({
      snapshot: snapshot({
        resetCredits: { availableCount: 2, earliestExpiresAt: Date.now() - 60_000 },
      }),
    })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))
    expect(screen.getByTestId('acp-usage-popover').textContent).toContain('expired')
  })

  it('omits the expiry hint when none is reported', () => {
    renderIndicator({ snapshot: snapshot({ resetCredits: { availableCount: 2 } }) })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))
    const popover = screen.getByTestId('acp-usage-popover')
    expect(popover.textContent).toContain('Reset credits: 2')
    expect(popover.textContent).not.toContain('expires')
  })
})

describe('UsageIndicator — redeeming a reset credit', () => {
  function openWithCredits(overrides: Parameters<typeof renderIndicator>[0] = {}): Harness {
    const harness = renderIndicator({
      snapshot: snapshot({ resetCredits: { availableCount: 2 } }),
      ...overrides,
    })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))
    return harness
  }

  it('confirms first — the credit is consumed irreversibly', async () => {
    const { confirm, consumeResetCredit } = openWithCredits({ confirmed: false })
    await act(async () => {
      fireEvent.click(screen.getByTestId('acp-usage-reset-credit'))
    })
    expect(confirm).toHaveBeenCalled()
    expect(consumeResetCredit).not.toHaveBeenCalled()
  })

  it('sends one idempotency key per confirmed attempt', async () => {
    const { consumeResetCredit, notify } = openWithCredits()
    await act(async () => {
      fireEvent.click(screen.getByTestId('acp-usage-reset-credit'))
    })
    expect(consumeResetCredit).toHaveBeenCalledTimes(1)
    const [agentId, authority, key] = consumeResetCredit.mock.calls[0] as [
      string,
      string | undefined,
      string,
    ]
    expect(agentId).toBe('codex')
    expect(authority).toBeUndefined()
    expect(key).toMatch(/[0-9a-f-]{36}/)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: Severity.Info as number }),
    )
  })

  it.each([
    ['reset', Severity.Info],
    ['alreadyRedeemed', Severity.Info],
    ['nothingToReset', Severity.Info],
    ['noCredit', Severity.Warning],
    ['unavailable', Severity.Warning],
    ['failed', Severity.Error],
  ] as ReadonlyArray<readonly [ResetCreditOutcome, Severity]>)(
    'reports the %s outcome to the user',
    async (outcome, severity) => {
      const { notify } = openWithCredits({ outcome })
      await act(async () => {
        fireEvent.click(screen.getByTestId('acp-usage-reset-credit'))
      })
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ severity: severity as number }))
    },
  )
})

describe('UsageIndicator — account usage', () => {
  const accountUsage: AiAccountUsage = {
    kind: 'balance',
    remainingUSD: 12.5,
    fetchedAt: FETCHED_AT,
  }

  it('shows the remaining balance for a declared account source', () => {
    renderIndicator({
      agentId: 'codex',
      snapshot: undefined,
      account: { hasSource: true, usage: accountUsage },
    })
    expect(screen.getByTestId('acp-usage-indicator').textContent).toBe('$12.50')
  })

  it('shows used over limit when remaining is not reported', () => {
    renderIndicator({
      agentId: 'codex',
      snapshot: undefined,
      account: {
        hasSource: true,
        usage: { kind: 'quota', usedUSD: 3, limitUSD: 50, fetchedAt: FETCHED_AT },
      },
    })
    expect(screen.getByTestId('acp-usage-indicator').textContent).toBe('$3.00 / $50.00')
  })

  it('renders ¥ for a CNY account', () => {
    renderIndicator({
      agentId: 'codex',
      snapshot: undefined,
      account: {
        hasSource: true,
        usage: { kind: 'balance', remainingUSD: 7, currency: 'CNY', fetchedAt: FETCHED_AT },
      },
    })
    expect(screen.getByTestId('acp-usage-indicator').textContent).toBe('¥7.00')
  })

  it('renders the unavailable readout when the source is declared but empty', () => {
    renderIndicator({ agentId: 'codex', snapshot: undefined, account: { hasSource: true } })
    const button = screen.getByTestId('acp-usage-indicator')
    expect(button.getAttribute('data-state')).toBe('unavailable')
    expect(button.textContent).toContain('Unavailable')
  })

  it('forces a refresh when the unavailable readout is clicked', () => {
    const { accountRefresh } = renderIndicator({
      agentId: 'codex',
      snapshot: undefined,
      account: { hasSource: true },
    })
    fireEvent.click(screen.getByTestId('acp-usage-indicator'))
    expect(accountRefresh).toHaveBeenCalledWith('codex', undefined, { force: true })
  })
})
