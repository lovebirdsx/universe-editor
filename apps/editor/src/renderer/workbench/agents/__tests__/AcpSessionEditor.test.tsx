/*---------------------------------------------------------------------------------------------
 *  Tests for AcpSessionEditor — covers the "editor restart" path where a
 *  serialized AcpSessionEditorInput is restored but no live session matches.
 *  The editor should auto-resume; on failure it should show an error and a
 *  retry button that re-triggers resume.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import {
  InstantiationService,
  ServiceCollection,
  observableValue,
  Emitter,
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
    resumeResult?: () => Promise<IAcpSession>
  } = {},
): FakeAcpSessionService {
  const byId = new Map<string, IAcpSession>(Object.entries(initial.byId ?? {}))
  const sessions = observableValue<readonly IAcpSession[]>('test.sessions', [...byId.values()])
  const activeSessionId = observableValue<string | undefined>('test.activeId', undefined)
  const activeSession = observableValue<IAcpSession | undefined>('test.active', undefined)
  const resumeSession = vi
    .fn()
    .mockImplementation(
      initial.resumeResult ?? (() => Promise.resolve(undefined as unknown as IAcpSession)),
    )
  const createSession = vi.fn().mockResolvedValue(undefined as unknown as IAcpSession)
  const onDidCloseSession = new Emitter<string>()
  return {
    _serviceBrand: undefined,
    sessions,
    sessionsObs: sessions,
    activeSessionId,
    activeSession,
    onDidCloseSession: onDidCloseSession.event,
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

function makeHistory(
  get: (id: string) => AcpSessionHistoryEntry | undefined = (id) =>
    ({
      id,
      agentId: 'fake',
      sessionIdOnAgent: id,
      title: id,
      createdAt: 0,
      lastUsedAt: 0,
    }) as AcpSessionHistoryEntry,
): IAcpSessionHistoryServiceType {
  return {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.history', []),
    get,
    list: () => [],
    async initialize() {},
  } as unknown as IAcpSessionHistoryServiceType
}

function makeEditor(): IEditorServiceType {
  return {
    _serviceBrand: undefined,
    openEditor: vi.fn(),
    closeEditor: vi.fn(),
  } as unknown as IEditorServiceType
}

const stubEditor = makeEditor()

function makeCollection(
  service: FakeAcpSessionService,
  history?: IAcpSessionHistoryServiceType,
  editor: IEditorServiceType = stubEditor,
) {
  const services = new ServiceCollection()
  services.set(IAcpSessionService, service)
  services.set(IAcpSessionHistoryService, history ?? makeHistory())
  services.set(IEditorService, editor)
  return services
}

function buildInput(service: FakeAcpSessionService, sessionId: string, agentId?: string) {
  const inst = new InstantiationService(makeCollection(service))
  return { inst, input: inst.createInstance(AcpSessionEditorInput, sessionId, agentId, undefined) }
}

function renderEditor(
  service: FakeAcpSessionService,
  input: AcpSessionEditorInput,
  history?: IAcpSessionHistoryServiceType,
  editor?: IEditorServiceType,
) {
  const inst = new InstantiationService(makeCollection(service, history, editor))
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
    expect(screen.getByTestId('acp-session-resuming')).toBeTruthy()
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

  it('resumes the newly-selected session after the editor view switches inputs', async () => {
    // Repro for "switch to the 2nd restored session → spins forever, never
    // errors, switching does nothing". EditorGroupView renders the active
    // editor as `<Component input={active} />` with NO key, so flipping tabs
    // REUSES the same AcpSessionEditor instance and only swaps the `input`
    // prop. The component's `phase` state therefore leaks across inputs: once
    // it is `'pending'` (set on the first input's resume and never reset on
    // success), the `phase.kind !== 'idle'` guard blocks the second input's
    // resume forever — no resumeSession call, no session/load, endless spinner.
    const service = makeService()
    const inst = new InstantiationService(makeCollection(service))
    const inputA = inst.createInstance(AcpSessionEditorInput, 'sess-A', 'fake', undefined)
    const inputB = inst.createInstance(AcpSessionEditorInput, 'sess-B', 'fake', undefined)

    let rerender!: (ui: React.ReactElement) => void
    await act(async () => {
      const r = render(
        <ServicesContext.Provider value={inst}>
          <AcpSessionEditor input={inputA} />
        </ServicesContext.Provider>,
      )
      rerender = r.rerender
    })
    expect(service.resumeSession).toHaveBeenCalledWith('sess-A')

    // Flip the same editor view to the other session (like clicking its tab).
    await act(async () => {
      rerender(
        <ServicesContext.Provider value={inst}>
          <AcpSessionEditor input={inputB} />
        </ServicesContext.Provider>,
      )
    })

    // The newly-selected session MUST get its own resume.
    expect(service.resumeSession).toHaveBeenCalledWith('sess-B')
  })

  it('renders an error + Retry when resumeSession rejects, and retry re-invokes resumeSession', async () => {
    const service = makeService({
      resumeResult: () => Promise.reject(new Error('boom')),
    })
    const { input } = buildInput(service, 'sess-broken', 'fake')
    await act(async () => {
      renderEditor(service, input)
    })
    // First call failed -> error UI replaces the spinner.
    expect(service.resumeSession).toHaveBeenCalledTimes(1)
    const retry = await screen.findByTestId('acp-session-resume-retry')
    expect(screen.getByTestId('acp-session-resume-error')).toBeTruthy()
    await act(async () => {
      fireEvent.click(retry)
    })
    expect(service.resumeSession).toHaveBeenCalledTimes(2)
  })

  it('closes its own tab silently (no error UI) when resume fails and the session vanished from history', async () => {
    // Repro for bug2: an empty session (created but never messaged) cannot be
    // resumed after a restart — the agent never persisted it. resumeSession
    // rejects AND drops the history row. The editor must NOT show a resume
    // error; it must close its own tab.
    const service = makeService({
      resumeResult: () => Promise.reject(new Error('Unknown agent session id')),
    })
    const { input } = buildInput(service, 'sess-empty', 'fake')
    const editor = makeEditor()
    // History reports the session as gone (it was discarded on resume failure).
    const history = makeHistory(() => undefined)
    await act(async () => {
      renderEditor(service, input, history, editor)
    })
    expect(service.resumeSession).toHaveBeenCalledTimes(1)
    // No error UI — the tab is being closed instead.
    expect(screen.queryByTestId('acp-session-resume-error')).toBeNull()
    expect(editor.closeEditor).toHaveBeenCalledWith(input.id)
  })
})
