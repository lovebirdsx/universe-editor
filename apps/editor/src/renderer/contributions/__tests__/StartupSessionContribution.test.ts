/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for StartupSessionContribution — the window consumes the session work it
 *  was opened/focused for, at cold launch (argv) and after startup (IPC push):
 *    - `open-session` resumes the existing session immediately.
 *    - `new-agent-session` creates a session once user settings have hydrated,
 *      carrying the remote authority when the cwd lives on another host.
 *    - Both IPC subscriptions are released with the contribution.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstantiationService, ServiceCollection } from '@universe-editor/platform'
import type { IAcpSessionService } from '../../services/acp/session/acpSessionService.js'
import { IAcpSessionService as AcpSessionServiceToken } from '../../services/acp/session/acpSessionService.js'
import type { IUserSettingsSyncService } from '../../services/configuration/UserSettingsSync.js'
import { IUserSettingsSyncService as UserSettingsSyncToken } from '../../services/configuration/UserSettingsSync.js'
import { StartupSessionContribution } from '../StartupSessionContribution.js'

interface NewAgentSessionRequest {
  readonly agentId: string
  readonly cwd: string
  readonly authority?: string
}

interface FakeIpc {
  openSessionId?: string
  newAgentSession?: NewAgentSessionRequest
  onOpenSession: ReturnType<typeof vi.fn>
  onNewAgentSession: ReturnType<typeof vi.fn>
}

function makeIpc(overrides: Partial<FakeIpc> = {}): FakeIpc {
  return {
    onOpenSession: vi.fn(() => () => undefined),
    onNewAgentSession: vi.fn(() => () => undefined),
    ...overrides,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let originalWindow: PropertyDescriptor | undefined

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
  originalWindow = undefined
})

function setup(ipc: FakeIpc, hydration = deferred()) {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    value: { ipc },
    configurable: true,
    writable: true,
  })

  const resumeSession = vi.fn(async () => ({}))
  const createSession = vi.fn(async () => ({}))
  const services = new ServiceCollection()
  services.set(AcpSessionServiceToken, {
    _serviceBrand: undefined,
    resumeSession,
    createSession,
  } as unknown as IAcpSessionService)
  services.set(UserSettingsSyncToken, {
    _serviceBrand: undefined,
    whenInitialized: hydration.promise,
    initialize: vi.fn(async () => undefined),
  } as unknown as IUserSettingsSyncService)
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(StartupSessionContribution)
  return { contribution, resumeSession, createSession, hydration }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('StartupSessionContribution', () => {
  it('resumes the session named by the cold-launch argv', () => {
    const { resumeSession } = setup(makeIpc({ openSessionId: 'sess-argv' }))
    expect(resumeSession).toHaveBeenCalledWith('sess-argv')
  })

  it('creates the routed cold-launch session once settings have hydrated', async () => {
    const { createSession, hydration } = setup(
      makeIpc({ newAgentSession: { agentId: 'claude-code', cwd: '/other' } }),
    )
    expect(createSession).not.toHaveBeenCalled()

    hydration.resolve()
    await flush()

    expect(createSession).toHaveBeenCalledWith('claude-code', { cwd: '/other' })
  })

  it('carries the remote authority into the created session', async () => {
    const { createSession, hydration } = setup(
      makeIpc({
        newAgentSession: { agentId: 'claude-code', cwd: '/remote/other', authority: 'myhost' },
      }),
    )
    hydration.resolve()
    await flush()

    expect(createSession).toHaveBeenCalledWith('claude-code', {
      cwd: '/remote/other',
      authority: 'myhost',
    })
  })

  it('creates a session pushed over IPC after startup', async () => {
    const ipc = makeIpc()
    const { createSession, hydration } = setup(ipc)
    const onNewAgentSession = ipc.onNewAgentSession.mock.calls[0]?.[0] as
      | ((request: NewAgentSessionRequest) => void)
      | undefined
    expect(onNewAgentSession).toBeDefined()

    onNewAgentSession!({ agentId: 'codex', cwd: '/other' })
    hydration.resolve()
    await flush()

    expect(createSession).toHaveBeenCalledWith('codex', { cwd: '/other' })
  })

  it('resumes a session pushed over IPC after startup', () => {
    const ipc = makeIpc()
    const { resumeSession } = setup(ipc)
    const onOpenSession = ipc.onOpenSession.mock.calls[0]?.[0] as
      | ((sessionId: string) => void)
      | undefined
    expect(onOpenSession).toBeDefined()

    onOpenSession!('sess-pushed')

    expect(resumeSession).toHaveBeenCalledWith('sess-pushed')
  })

  it('releases both IPC subscriptions on dispose', () => {
    const ipc = makeIpc()
    const unopen = vi.fn()
    const unnew = vi.fn()
    ipc.onOpenSession.mockReturnValue(unopen)
    ipc.onNewAgentSession.mockReturnValue(unnew)
    const { contribution } = setup(ipc)

    contribution.dispose()

    expect(unopen).toHaveBeenCalledTimes(1)
    expect(unnew).toHaveBeenCalledTimes(1)
  })
})
