/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpSessionEditorInput.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
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
import {
  IAcpChatWidgetService,
  type IAcpChatWidgetService as IAcpChatWidgetServiceType,
} from '../acpChatWidgetService.js'

function makeAccessor(
  rows: AcpSessionHistoryEntry[] = [],
  opts: {
    getById?: (id: string) => IAcpSession | undefined
    focusSessionInput?: (id: string) => boolean
  } = {},
): {
  accessor: ServicesAccessor
  inst: IInstantiationService
} {
  const sessions = {
    _serviceBrand: undefined,
    sessions: observableValue<readonly IAcpSession[]>('test.sessions', []),
    activeSessionId: observableValue<string | undefined>('test.activeId', undefined),
    activeSession: observableValue<IAcpSession | undefined>('test.active', undefined),
    getById: opts.getById ?? (() => undefined),
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
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.history', rows),
    get: (id: string) => rows.find((e) => e.sessionIdOnAgent === id),
    list: () => [],
    async initialize() {},
  } as unknown as IAcpSessionHistoryServiceType
  const chatWidget = {
    _serviceBrand: undefined,
    focusSessionInput: opts.focusSessionInput ?? (() => false),
  } as unknown as IAcpChatWidgetServiceType
  const services = new ServiceCollection()
  services.set(IAcpSessionService, sessions)
  services.set(IAcpSessionHistoryService, history)
  services.set(IAcpChatWidgetService, chatWidget)
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

  it('focus() resolves a durable sessionId (split clone) to the live local id before routing', () => {
    const focusSessionInput = vi.fn(() => true)
    const live = {
      id: 'local-1',
      sessionIdOnAgent: observableValue<string | undefined>('test.agentId', 'echo-1'),
    } as unknown as IAcpSession
    const { inst } = makeAccessor([], {
      getById: (id) => (id === 'echo-1' ? live : undefined),
      focusSessionInput,
    })
    // A split clone round-trips serialize/deserialize, which stores the durable
    // sessionIdOnAgent — so its `sessionId` is the agent id, not the local id.
    const clone = inst.createInstance(AcpSessionEditorInput, 'echo-1', 'claude-code', undefined)
    expect(clone.focus()).toBe(true)
    expect(focusSessionInput).toHaveBeenCalledWith('local-1')
  })

  it('focus() falls back to sessionId when the live session is gone', () => {
    const focusSessionInput = vi.fn(() => false)
    const { inst } = makeAccessor([], { focusSessionInput })
    const input = inst.createInstance(AcpSessionEditorInput, 'gone-1', 'claude-code', undefined)
    expect(input.focus()).toBe(false)
    expect(focusSessionInput).toHaveBeenCalledWith('gone-1')
  })

  it('isSideTask is true only when the history row carries a sideTaskOf flag', () => {
    const sideRow: AcpSessionHistoryEntry = {
      id: 'side-1',
      agentId: 'fake',
      sessionIdOnAgent: 'side-1',
      title: 'side chat',
      createdAt: 1,
      lastUsedAt: 1,
      sideTaskOf: 'parent-1',
      sideTaskQuote: 'quoted',
    }
    const { inst } = makeAccessor([sideRow])
    expect(inst.createInstance(AcpSessionEditorInput, 'side-1', 'fake', undefined).isSideTask).toBe(
      true,
    )
    expect(inst.createInstance(AcpSessionEditorInput, 'sess-x', 'fake', undefined).isSideTask).toBe(
      false,
    )
  })
})
