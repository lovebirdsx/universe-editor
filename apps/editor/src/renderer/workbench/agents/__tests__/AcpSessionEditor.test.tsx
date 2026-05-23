/*---------------------------------------------------------------------------------------------
 *  Tests for AcpSessionEditor — focuses on the "editor restart" path where a
 *  serialized AcpSessionEditorInput is restored but no live session matches.
 *  When the input carries a historyId we expect the editor to auto-resume.
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
import { AcpSessionEditorInput } from '../../../services/acp/acpSessionEditorInput.js'
import { AcpSessionEditor } from '../AcpSessionEditor.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

interface FakeAcpSessionService extends IAcpSessionServiceType {
  readonly sessionsObs: ReturnType<typeof observableValue<readonly IAcpSession[]>>
  readonly resumeSession: ReturnType<typeof vi.fn> & IAcpSessionServiceType['resumeSession']
  readonly createSession: ReturnType<typeof vi.fn> & IAcpSessionServiceType['createSession']
  readonly _byHistoryId: Map<string, IAcpSession>
  readonly _byId: Map<string, IAcpSession>
}

function makeService(
  initial: {
    byId?: Record<string, IAcpSession>
    byHistoryId?: Record<string, IAcpSession>
  } = {},
): FakeAcpSessionService {
  const byId = new Map<string, IAcpSession>(Object.entries(initial.byId ?? {}))
  const byHistoryId = new Map<string, IAcpSession>(Object.entries(initial.byHistoryId ?? {}))
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
    _byHistoryId: byHistoryId,
    createSession: createSession as never,
    resumeSession: resumeSession as never,
    setActive(): void {},
    async closeSession(): Promise<void> {},
    getById(id: string): IAcpSession | undefined {
      return byId.get(id)
    },
    getByHistoryId(id: string): IAcpSession | undefined {
      return byHistoryId.get(id)
    },
    async tryRestoreActiveSession(): Promise<void> {},
  } satisfies FakeAcpSessionService
}

const stubEditor: IEditorServiceType = {
  _serviceBrand: undefined,
  openEditor: vi.fn(),
  closeEditor: vi.fn(),
} as unknown as IEditorServiceType

function renderEditor(service: FakeAcpSessionService, input: AcpSessionEditorInput) {
  const services = new ServiceCollection()
  services.set(IAcpSessionService, service)
  services.set(IEditorService, stubEditor)
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <AcpSessionEditor input={input} />
    </ServicesContext.Provider>,
  )
}

describe('AcpSessionEditor — auto-resume after editor restart', () => {
  it('auto-calls service.resumeSession when input carries a historyId but no live session matches', async () => {
    const service = makeService()
    const input = new AcpSessionEditorInput('s-stale', 'fake', 'h7-xyz')
    await act(async () => {
      renderEditor(service, input)
    })
    expect(service.resumeSession).toHaveBeenCalledTimes(1)
    expect(service.resumeSession).toHaveBeenCalledWith('h7-xyz')
    // While resume is pending, a 'resuming' placeholder should be shown rather
    // than the legacy "missing" reconnect button.
    expect(screen.queryByTestId('acp-session-reconnect')).toBeNull()
    expect(screen.getByTestId('acp-session-resuming')).toBeTruthy()
  })

  it('does NOT auto-resume when no historyId is present (legacy missing UI)', async () => {
    const service = makeService()
    const input = new AcpSessionEditorInput('s-stale', 'fake')
    await act(async () => {
      renderEditor(service, input)
    })
    expect(service.resumeSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('acp-session-reconnect')).toBeTruthy()
  })

  it('does not call resumeSession a second time even if the component re-renders', async () => {
    const service = makeService()
    const input = new AcpSessionEditorInput('s-stale', 'fake', 'h7-xyz')
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

function makeCollection(service: FakeAcpSessionService) {
  const services = new ServiceCollection()
  services.set(IAcpSessionService, service)
  services.set(IEditorService, stubEditor)
  return services
}
