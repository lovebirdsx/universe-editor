/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionEditorInput.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { AcpSessionEditorInput } from '../acpSessionEditorInput.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../acpSessionHistory.js'

function makeAccessor(): {
  accessor: ServicesAccessor
  inst: IInstantiationService
} {
  const sessions = {
    _serviceBrand: undefined,
    sessions: observableValue<readonly IAcpSession[]>('test.sessions', []),
    activeSessionId: observableValue<string | undefined>('test.activeId', undefined),
    activeSession: observableValue<IAcpSession | undefined>('test.active', undefined),
    getById: () => undefined,
    setActive() {},
    async createSession(): Promise<IAcpSession> {
      throw new Error('unused')
    },
    async resumeSession(): Promise<IAcpSession> {
      throw new Error('unused')
    },
    async closeSession() {},
    async tryRestoreActiveSession() {},
    requestHydrateIfNeeded() {},
    async refreshSessions() {},
    async deleteOnAgent(): Promise<'ok' | 'unsupported' | 'unknown' | 'error'> {
      return 'unsupported'
    },
  } as unknown as IAcpSessionServiceType
  const history = {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.history', []),
    get: () => undefined,
    list: () => [],
    async initialize() {},
  } as unknown as IAcpSessionHistoryServiceType
  const services = new ServiceCollection()
  services.set(IAcpSessionService, sessions)
  services.set(IAcpSessionHistoryService, history)
  const inst = new InstantiationService(services)
  const accessor: ServicesAccessor = { get: (id) => inst.invokeFunction((a) => a.get(id)) }
  return { accessor, inst }
}

function makeInput(sessionId: string, agentId?: string): AcpSessionEditorInput {
  const { inst } = makeAccessor()
  return inst.createInstance(AcpSessionEditorInput, sessionId, agentId, undefined)
}

describe('AcpSessionEditorInput', () => {
  it('serialize/deserialize round-trips sessionId and agentId', () => {
    const { accessor, inst } = makeAccessor()
    const input = inst.createInstance(AcpSessionEditorInput, 'sess-1', 'claude-code', undefined)
    const restored = AcpSessionEditorInput.deserialize(input.serialize(), accessor)
    expect(restored?.sessionId).toBe('sess-1')
    expect(restored?.agentId).toBe('claude-code')
  })

  it('serialize omits agentId when not provided so payload stays minimal', () => {
    const input = makeInput('sess-2')
    const payload = JSON.parse(input.serialize())
    expect(payload.sessionId).toBe('sess-2')
    expect('agentId' in payload).toBe(false)
  })

  it('serialize persists the current title so the tab can render it before history hydrates', () => {
    const { inst } = makeAccessor()
    const input = inst.createInstance(AcpSessionEditorInput, 'sess-2t', 'fake', '我的会话')
    const payload = JSON.parse(input.serialize())
    expect(payload.title).toBe('我的会话')
  })

  it('deserialize accepts payloads without agentId', () => {
    const { accessor } = makeAccessor()
    const restored = AcpSessionEditorInput.deserialize(
      JSON.stringify({ sessionId: 'sess-3' }),
      accessor,
    )
    expect(restored?.sessionId).toBe('sess-3')
    expect(restored?.agentId).toBeUndefined()
  })

  it('deserialize preserves persisted title even when no live session and no history entry exists', () => {
    const { accessor } = makeAccessor()
    const restored = AcpSessionEditorInput.deserialize(
      JSON.stringify({ sessionId: 'sess-3t', title: '上次的会话' }),
      accessor,
    )
    expect(restored?.getName()).toBe('上次的会话')
  })

  it('deserialize ignores malformed payloads', () => {
    const { accessor } = makeAccessor()
    expect(AcpSessionEditorInput.deserialize('not-json', accessor)).toBeNull()
    expect(
      AcpSessionEditorInput.deserialize(JSON.stringify({ sessionId: 42 }), accessor),
    ).toBeNull()
    expect(AcpSessionEditorInput.deserialize(42 as unknown, accessor)).toBeNull()
  })

  it('deserialize discards agentId of wrong type while keeping sessionId', () => {
    const { accessor } = makeAccessor()
    const restored = AcpSessionEditorInput.deserialize(
      JSON.stringify({ sessionId: 'sess-4', agentId: 7 }),
      accessor,
    )
    expect(restored?.sessionId).toBe('sess-4')
    expect(restored?.agentId).toBeUndefined()
  })

  it('resource is keyed by sessionId so two inputs with the same id collapse', () => {
    const { inst } = makeAccessor()
    const a = inst.createInstance(AcpSessionEditorInput, 'sess-9', 'fake', undefined)
    const b = inst.createInstance(AcpSessionEditorInput, 'sess-9', 'fake', undefined)
    expect(a.resource.toString()).toBe(b.resource.toString())
    expect(a.matches(b)).toBe(true)
  })

  it('resource path encodes the sessionId', () => {
    const input = makeInput('sess-10')
    expect(input.resource.path).toBe('/acp/session/sess-10')
  })
})
