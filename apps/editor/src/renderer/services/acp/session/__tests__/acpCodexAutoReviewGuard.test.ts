/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Severity,
  observableValue,
  type INotificationService,
  type ISettableObservable,
} from '@universe-editor/platform'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { ICodexConfigService } from '../../../../../shared/ipc/codexConfigService.js'
import type { IAcpSession } from '../acpSessionModel.js'
import {
  AcpCodexAutoReviewGuard,
  autoReviewAvailabilityFor,
  CODEX_AUTO_REVIEW_MODE_ID,
  MODE_CONFIG_ID,
} from '../acpCodexAutoReviewGuard.js'
import { StubLoggerService } from '../../../../__tests__/_helpers/stubLoggerService.js'

const CODEX = 'codex'
const CLAUDE = 'claude-code'
const REMOTE = 'ssh-remote+dev'

function modeOption(currentValue: string): SessionConfigOption {
  return {
    id: MODE_CONFIG_ID,
    category: 'mode',
    type: 'select',
    name: 'Mode',
    currentValue,
    options: [
      { value: 'read-only', name: 'Read-only' },
      { value: 'workspace-write', name: 'Workspace access' },
      { value: CODEX_AUTO_REVIEW_MODE_ID, name: 'Auto review' },
    ],
  }
}

interface Harness {
  service: AcpCodexAutoReviewGuard
  resolveActiveAuth: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  dismiss: ReturnType<typeof vi.fn>
  changeCredential: () => void
}

function harness(): Harness {
  const resolveActiveAuth = vi.fn().mockResolvedValue({ kind: 'subscription' })
  const authChanged = new Emitter<void>()
  const codexConfig = {
    onDidChangeAuth: authChanged.event,
    resolveActiveAuth,
  } as unknown as ICodexConfigService
  let nextId = 1
  const notify = vi.fn().mockImplementation(() => ({ id: `n${nextId++}`, dispose: () => {} }))
  const dismiss = vi.fn()
  const notifications = { notify, dismiss } as unknown as INotificationService
  const service = new AcpCodexAutoReviewGuard(codexConfig, notifications, new StubLoggerService())
  return {
    service,
    resolveActiveAuth,
    notify,
    dismiss,
    changeCredential: () => authChanged.fire(),
  }
}

interface WatchedSession {
  session: IAcpSession
  config: ISettableObservable<readonly SessionConfigOption[]>
  setConfigOption: ReturnType<typeof vi.fn>
}

function fakeSession(
  agentId: string,
  mode: string,
  authority?: string,
  opts: { readOnly?: boolean } = {},
): WatchedSession {
  const config = observableValue<readonly SessionConfigOption[]>('cfg', [modeOption(mode)])
  const setConfigOption = vi.fn().mockResolvedValue(undefined)
  const session = {
    id: 's1',
    agentId,
    authority,
    readOnly: opts.readOnly ?? false,
    configOptions: config,
    setConfigOption,
  } as unknown as IAcpSession
  return { session, config, setConfigOption }
}

interface RecordedNotification {
  severity: Severity
  sticky: boolean
  message: string
  actions: { run: () => void }[]
}

function notificationAt(notify: ReturnType<typeof vi.fn>, index: number): RecordedNotification {
  return notify.mock.calls[index]![0] as RecordedNotification
}

/** Take the offer the way the toast does — the run callback itself returns void. */
function takeOffer(notification: RecordedNotification): void {
  notification.actions[0]!.run()
}

describe('autoReviewAvailabilityFor', () => {
  it('is unavailable for a custom provider, which does not serve the reviewer slug', () => {
    expect(autoReviewAvailabilityFor({ kind: 'provider', providerId: 'gw' })).toBe('unavailable')
    // A hand-written provider the editor cannot attribute is still not OpenAI.
    expect(autoReviewAvailabilityFor({ kind: 'provider' })).toBe('unavailable')
  })

  it('is available for the subscription and the official API key', () => {
    expect(autoReviewAvailabilityFor({ kind: 'subscription' })).toBe('available')
    expect(autoReviewAvailabilityFor({ kind: 'none' })).toBe('available')
  })

  it('is unknown before the credential has been read', () => {
    expect(autoReviewAvailabilityFor(undefined)).toBe('unknown')
  })
})

describe('AcpCodexAutoReviewGuard availability', () => {
  it('never asks about an agent that has no such reviewer', () => {
    const { service, resolveActiveAuth } = harness()

    expect(service.getAutoReviewAvailability(CLAUDE)).toBe('available')
    expect(resolveActiveAuth).not.toHaveBeenCalled()
    service.dispose()
  })

  it('reports unavailable once a custom provider binding is read', async () => {
    const { service, resolveActiveAuth } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'gw' })

    // Cold: fail open rather than accusing the session before we know.
    expect(service.getAutoReviewAvailability(CODEX)).toBe('unknown')
    await service.refresh()
    expect(service.getAutoReviewAvailability(CODEX)).toBe('unavailable')
    service.dispose()
  })

  it('keeps hosts apart — the same agent can run on different credentials', async () => {
    const { service, resolveActiveAuth } = harness()
    resolveActiveAuth.mockImplementation((authority?: string) =>
      Promise.resolve(authority === undefined ? { kind: 'subscription' } : { kind: 'provider' }),
    )

    service.getAutoReviewAvailability(CODEX)
    service.getAutoReviewAvailability(CODEX, REMOTE)
    await service.refresh()

    expect(service.getAutoReviewAvailability(CODEX)).toBe('available')
    expect(service.getAutoReviewAvailability(CODEX, REMOTE)).toBe('unavailable')
    service.dispose()
  })

  it('fails open when the credential cannot be read', async () => {
    const { service, resolveActiveAuth } = harness()
    resolveActiveAuth.mockRejectedValue(new Error('unreadable'))

    service.getAutoReviewAvailability(CODEX)
    await service.refresh()
    expect(service.getAutoReviewAvailability(CODEX)).toBe('unknown')
    service.dispose()
  })

  it('re-resolves when the credential changes', async () => {
    const { service, resolveActiveAuth, changeCredential } = harness()
    service.getAutoReviewAvailability(CODEX)
    await service.refresh()
    expect(service.getAutoReviewAvailability(CODEX)).toBe('available')

    resolveActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'gw' })
    changeCredential()
    await service.refresh()
    expect(service.getAutoReviewAvailability(CODEX)).toBe('unavailable')
    service.dispose()
  })
})

describe('AcpCodexAutoReviewGuard session watch', () => {
  it('warns, with a switch offer, when Auto review meets an unserved reviewer', async () => {
    const { service, resolveActiveAuth, notify } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'gw' })
    const { session } = fakeSession(CODEX, CODEX_AUTO_REVIEW_MODE_ID)

    const watch = service.watchSession(session)
    expect(notify).not.toHaveBeenCalled()

    await service.refresh()
    expect(notify).toHaveBeenCalledTimes(1)
    const warning = notificationAt(notify, 0)
    expect(warning.severity).toBe(Severity.Warning)
    expect(warning.sticky).toBe(true)
    expect(warning.actions).toHaveLength(1)

    watch.dispose()
    service.dispose()
  })

  it('leaves a session alone while the reviewer can still be served', async () => {
    const { service, notify } = harness()
    const { session } = fakeSession(CODEX, CODEX_AUTO_REVIEW_MODE_ID)

    const watch = service.watchSession(session)
    await service.refresh()

    expect(notify).not.toHaveBeenCalled()
    watch.dispose()
    service.dispose()
  })

  it('waits for Auto review to actually be on before saying anything', async () => {
    const { service, resolveActiveAuth, notify } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'gw' })
    const { session, config } = fakeSession(CODEX, 'workspace-write')

    const watch = service.watchSession(session)
    await service.refresh()
    expect(notify).not.toHaveBeenCalled()

    // Switching in by hand is the same dead end, so say it then too.
    config.set([modeOption(CODEX_AUTO_REVIEW_MODE_ID)], undefined)
    expect(notify).toHaveBeenCalledTimes(1)

    watch.dispose()
    service.dispose()
  })

  it('withdraws the warning once the session leaves Auto review, and says it again on return', async () => {
    const { service, resolveActiveAuth, notify, dismiss } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'gw' })
    const { session, config } = fakeSession(CODEX, CODEX_AUTO_REVIEW_MODE_ID)
    const watch = service.watchSession(session)
    await service.refresh()
    expect(notify).toHaveBeenCalledTimes(1)

    config.set([modeOption('workspace-write')], undefined)
    expect(dismiss).toHaveBeenCalledWith('n1')

    // Back into the dead end: the toast it withdrew described a state that is
    // true again, so it must come back rather than stay silent.
    config.set([modeOption(CODEX_AUTO_REVIEW_MODE_ID)], undefined)
    expect(notify).toHaveBeenCalledTimes(2)

    watch.dispose()
    service.dispose()
  })

  it('withdraws the warning when the credential can serve the reviewer again', async () => {
    const { service, resolveActiveAuth, notify, dismiss, changeCredential } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'gw' })
    const { session } = fakeSession(CODEX, CODEX_AUTO_REVIEW_MODE_ID)
    const watch = service.watchSession(session)
    await service.refresh()
    expect(notify).toHaveBeenCalledTimes(1)

    resolveActiveAuth.mockResolvedValue({ kind: 'subscription' })
    changeCredential()
    await service.refresh()
    expect(dismiss).toHaveBeenCalledWith('n1')

    watch.dispose()
    service.dispose()
  })

  it('takes its warning down with the session, and stays quiet afterwards', async () => {
    const { service, resolveActiveAuth, notify, dismiss } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider' })
    const { session, config } = fakeSession(CODEX, CODEX_AUTO_REVIEW_MODE_ID)
    const watch = service.watchSession(session)
    await service.refresh()

    watch.dispose()
    expect(dismiss).toHaveBeenCalledWith('n1')

    config.set([modeOption('workspace-write')], undefined)
    config.set([modeOption(CODEX_AUTO_REVIEW_MODE_ID)], undefined)
    expect(notify).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('never watches a read-only preview, which offers no fix to apply', async () => {
    const { service, resolveActiveAuth, notify } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider' })
    const { session } = fakeSession(CODEX, CODEX_AUTO_REVIEW_MODE_ID, undefined, { readOnly: true })

    service.watchSession(session)
    await service.refresh()

    expect(notify).not.toHaveBeenCalled()
    service.dispose()
  })

  it('does not lose a credential change that lands while a resolve is in flight', async () => {
    const { service, resolveActiveAuth, changeCredential } = harness()
    let release = (): void => {}
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    resolveActiveAuth.mockImplementation(async () => {
      await inFlight
      return { kind: 'subscription' }
    })

    service.getAutoReviewAvailability(CODEX)
    resolveActiveAuth.mockResolvedValue({ kind: 'provider', providerId: 'gw' })
    changeCredential()
    release()
    await service.refresh()

    expect(service.getAutoReviewAvailability(CODEX)).toBe('unavailable')
    service.dispose()
  })

  it('never watches another agent', async () => {
    const { service, resolveActiveAuth, notify } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider' })
    const { session } = fakeSession(CLAUDE, 'auto')

    service.watchSession(session)
    await service.refresh()

    expect(resolveActiveAuth).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    service.dispose()
  })

  it('switches the session to Workspace access when the offer is taken', async () => {
    const { service, resolveActiveAuth, notify, dismiss } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider' })
    const { session, config, setConfigOption } = fakeSession(CODEX, CODEX_AUTO_REVIEW_MODE_ID)
    const watch = service.watchSession(session)
    await service.refresh()

    takeOffer(notificationAt(notify, 0))
    await vi.waitFor(() =>
      expect(setConfigOption).toHaveBeenCalledWith(MODE_CONFIG_ID, 'workspace-write'),
    )
    // The applied mode comes back through the option bag, which is what makes
    // the toast retire itself instead of sitting there offering a done deal.
    config.set([modeOption('workspace-write')], undefined)
    expect(dismiss).toHaveBeenCalledWith('n1')

    watch.dispose()
    service.dispose()
  })

  it('reports an apply failure rather than dropping the offer silently', async () => {
    const { service, resolveActiveAuth, notify } = harness()
    resolveActiveAuth.mockResolvedValue({ kind: 'provider' })
    const { session, setConfigOption } = fakeSession(CODEX, CODEX_AUTO_REVIEW_MODE_ID)
    setConfigOption.mockRejectedValue(new Error('asleep'))
    const watch = service.watchSession(session)
    await service.refresh()

    takeOffer(notificationAt(notify, 0))
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2))

    expect(notificationAt(notify, 1).severity).toBe(Severity.Error)
    watch.dispose()
    service.dispose()
  })
})
