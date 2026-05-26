/*---------------------------------------------------------------------------------------------
 *  Tests for AcpSessionEditor — focuses on the "editor restart" path where a
 *  serialized AcpSessionEditorInput is restored but no live session matches.
 *  The editor should auto-resume the session by id.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import {
  InstantiationService,
  ServiceCollection,
  observableValue,
  IEditorService,
} from '@universe-editor/platform'
import type { IEditorService as IEditorServiceType } from '@universe-editor/platform'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../../services/acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../../services/acp/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../../../services/acp/acpSessionEditorInput.js'
import { AcpSessionEditor } from '../AcpSessionEditor.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

interface FakeAcpSessionService extends IAcpSessionServiceType {
  readonly sessionsObs: ReturnType<typeof observableValue<readonly IAcpSession[]>>
  readonly resumeSession: ReturnType<typeof vi.fn> & IAcpSessionServiceType['resumeSession']
  readonly createSession: ReturnType<typeof vi.fn> & IAcpSessionServiceType['createSession']
  readonly _byId: Map<string, IAcpSession>
}

function makeService(
  initial: {
    byId?: Record<string, IAcpSession>
  } = {},
): FakeAcpSessionService {
  const byId = new Map<string, IAcpSession>(Object.entries(initial.byId ?? {}))
  const sessions = observableValue<readonly IAcpSession[]>('test.sessions', [...byId.values()])
  const activeSessionId = observableValue<string | undefined>('test.activeId', undefined)
  const activeSession = observableValue<IAcpSession | undefined>('test.active', undefined)
  const resumeSession = vi.fn().mockResolvedValue(undefined as unknown as IAcpSession)
  const createSession = vi.fn().mockResolvedValue(undefined as unknown as IAcpSession)
  return {
    _serviceBrand: undefined,
    sessions,
    sessionsObs: sessions,
    activeSessionId,
    activeSession,
    _byId: byId,
    createSession: createSession as never,
    resumeSession: resumeSession as never,
    setActive(): void {},
    async closeSession(): Promise<void> {},
    getById(id: string): IAcpSession | undefined {
      return byId.get(id)
    },
    async tryRestoreActiveSession(): Promise<void> {},
    requestHydrateIfNeeded(): void {},
    async refreshSessions(): Promise<void> {},
    async deleteOnAgent(): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> {
      return 'unsupported'
    },
  } satisfies FakeAcpSessionService
}

function makeHistory(): IAcpSessionHistoryServiceType {
  return {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.history', []),
    get: () => undefined,
    list: () => [],
    async initialize() {},
  } as unknown as IAcpSessionHistoryServiceType
}

const stubEditor: IEditorServiceType = {
  _serviceBrand: undefined,
  openEditor: vi.fn(),
  closeEditor: vi.fn(),
} as unknown as IEditorServiceType

function makeCollection(service: FakeAcpSessionService) {
  const services = new ServiceCollection()
  services.set(IAcpSessionService, service)
  services.set(IAcpSessionHistoryService, makeHistory())
  services.set(IEditorService, stubEditor)
  return services
}

function buildInput(service: FakeAcpSessionService, sessionId: string, agentId?: string) {
  const inst = new InstantiationService(makeCollection(service))
  return { inst, input: inst.createInstance(AcpSessionEditorInput, sessionId, agentId) }
}

function renderEditor(service: FakeAcpSessionService, input: AcpSessionEditorInput) {
  const inst = new InstantiationService(makeCollection(service))
  return render(
    <ServicesContext.Provider value={inst}>
      <AcpSessionEditor input={input} />
    </ServicesContext.Provider>,
  )
}

describe('AcpSessionEditor — auto-resume after editor restart', () => {
  it('auto-calls service.resumeSession when no live session matches the input id', async () => {
    const service = makeService()
    const { input } = buildInput(service, 'sess-stale', 'fake')
    await act(async () => {
      renderEditor(service, input)
    })
    expect(service.resumeSession).toHaveBeenCalledTimes(1)
    expect(service.resumeSession).toHaveBeenCalledWith('sess-stale')
    // While resume is pending, the resuming placeholder should be shown.
    expect(screen.getByTestId('acp-session-resuming')).toBeTruthy()
    expect(screen.getByTestId('acp-session-reconnect')).toBeTruthy()
  })

  it('does not call resumeSession a second time even if the component re-renders', async () => {
    const service = makeService()
    const { input } = buildInput(service, 'sess-stale', 'fake')
    let rerender: (ui: React.ReactElement) => void
    await act(async () => {
      const r = renderEditor(service, input)
      rerender = r.rerender
    })
    expect(service.resumeSession).toHaveBeenCalledTimes(1)
    await act(async () => {
      rerender!(
        <ServicesContext.Provider value={new InstantiationService(makeCollection(service))}>
          <AcpSessionEditor input={input} />
        </ServicesContext.Provider>,
      )
    })
    expect(service.resumeSession).toHaveBeenCalledTimes(1)
  })
})
