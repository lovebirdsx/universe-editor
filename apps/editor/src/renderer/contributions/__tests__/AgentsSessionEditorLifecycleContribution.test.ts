/*---------------------------------------------------------------------------------------------
 *  Tests for AgentsSessionEditorLifecycleContribution — verifies that closing
 *  an AcpSessionEditorInput tab stops the live agent session, except during
 *  AcpChatLocationService migrations or when the input is still open in
 *  another group.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  Emitter,
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupsService,
  type IEditorGroupModelChangeEvent,
  type IObservable,
} from '@universe-editor/platform'
import { AgentsSessionEditorLifecycleContribution } from '../AgentsContributions.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import type {
  IAcpChatLocationService,
  AcpChatLocation,
} from '../../services/acp/acpChatLocationService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../services/acp/acpSessionService.js'
import {
  IAcpSessionHistoryService,
  type AcpSessionHistoryEntry,
  type IAcpSessionHistoryService as IAcpSessionHistoryServiceType,
} from '../../services/acp/acpSessionHistory.js'

class FakeGroup {
  readonly id = 0
  readonly editors: EditorInput[] = []
  private readonly _emitter = new Emitter<IEditorGroupModelChangeEvent>()
  readonly onDidChangeModel = this._emitter.event
  fireClose(editor: EditorInput): void {
    this._emitter.fire({ kind: 'close', editor })
  }
}

class FakeEditorGroupsService {
  declare readonly _serviceBrand: undefined
  readonly groupList: FakeGroup[] = [new FakeGroup()]
  private readonly _addEmitter = new Emitter<IEditorGroup>()
  readonly onDidAddGroup = this._addEmitter.event
  get groups(): readonly IEditorGroup[] {
    return this.groupList as unknown as readonly IEditorGroup[]
  }
  addGroup(): FakeGroup {
    const g = new FakeGroup()
    this.groupList.push(g)
    this._addEmitter.fire(g as unknown as IEditorGroup)
    return g
  }
}

class FakeSessionService {
  declare readonly _serviceBrand: undefined
  readonly closed: string[] = []
  private readonly _byId = new Map<string, IAcpSession>()
  register(session: IAcpSession): void {
    this._byId.set(session.id, session)
  }
  getById(id: string): IAcpSession | undefined {
    return this._byId.get(id)
  }
  async closeSession(id: string): Promise<void> {
    this.closed.push(id)
  }
}

class FakeLocationService {
  declare readonly _serviceBrand: undefined
  isMigrating = false
  readonly location: IObservable<AcpChatLocation> = observableValue<AcpChatLocation>(
    'fake.location',
    'editor',
  )
  async initialize(): Promise<void> {}
  setLocation(): void {}
  toggle(): void {}
}

function makeSession(id: string, agentId: string): IAcpSession {
  return { id, agentId, title: id } as unknown as IAcpSession
}

interface Harness {
  groups: FakeEditorGroupsService
  sessions: FakeSessionService
  location: FakeLocationService
  contrib: AgentsSessionEditorLifecycleContribution
  inst: IInstantiationService
}

function makeHarness(): Harness {
  const groups = new FakeEditorGroupsService()
  const sessions = new FakeSessionService()
  const location = new FakeLocationService()
  // AcpSessionEditorInput needs both services via DI even though this
  // contribution test doesn't exercise titles/resume — the constructor's
  // autorun reads from them.
  const history = {
    _serviceBrand: undefined,
    entries: observableValue<readonly AcpSessionHistoryEntry[]>('test.history', []),
    get: () => undefined,
    list: () => [],
    async initialize() {},
  } as unknown as IAcpSessionHistoryServiceType
  const services = new ServiceCollection()
  services.set(IAcpSessionService, sessions as unknown as IAcpSessionServiceType)
  services.set(IAcpSessionHistoryService, history)
  const inst = new InstantiationService(services)
  const contrib = new AgentsSessionEditorLifecycleContribution(
    groups as unknown as IEditorGroupsService,
    sessions as unknown as IAcpSessionServiceType,
    location as unknown as IAcpChatLocationService,
  )
  return { groups, sessions, location, contrib, inst }
}

function makeInput(inst: IInstantiationService, sessionId: string, agentId: string) {
  return inst.createInstance(AcpSessionEditorInput, sessionId, agentId, undefined)
}

describe('AgentsSessionEditorLifecycleContribution', () => {
  it('closes the live session when an AcpSessionEditorInput tab is closed', () => {
    const h = makeHarness()
    h.sessions.register(makeSession('s1', 'fake'))
    const input = makeInput(h.inst, 's1', 'fake')
    h.groups.groupList[0]!.fireClose(input)
    expect(h.sessions.closed).toEqual(['s1'])
    h.contrib.dispose()
  })

  it('ignores closes of non-ACP editors', () => {
    const h = makeHarness()
    const fileInput = { id: 'file:foo' } as unknown as EditorInput
    h.groups.groupList[0]!.fireClose(fileInput)
    expect(h.sessions.closed).toEqual([])
    h.contrib.dispose()
  })

  it('skips closeSession while AcpChatLocationService.isMigrating is true', () => {
    const h = makeHarness()
    h.sessions.register(makeSession('s1', 'fake'))
    h.location.isMigrating = true
    const input = makeInput(h.inst, 's1', 'fake')
    h.groups.groupList[0]!.fireClose(input)
    expect(h.sessions.closed).toEqual([])
    h.contrib.dispose()
  })

  it('does not stop a session whose input is still open in another group', () => {
    const h = makeHarness()
    h.sessions.register(makeSession('s1', 'fake'))
    const input = makeInput(h.inst, 's1', 'fake')
    // Same input kept in a second group (simulated future split-view).
    const g2 = h.groups.addGroup()
    g2.editors.push(input)
    // Closed in group 0; group 1 still has it.
    h.groups.groupList[0]!.fireClose(input)
    expect(h.sessions.closed).toEqual([])
    h.contrib.dispose()
  })

  it('subscribes to groups added after construction', () => {
    const h = makeHarness()
    h.sessions.register(makeSession('s2', 'fake'))
    const g2 = h.groups.addGroup()
    const input = makeInput(h.inst, 's2', 'fake')
    g2.fireClose(input)
    expect(h.sessions.closed).toEqual(['s2'])
    h.contrib.dispose()
  })

  it('no-ops when no live session matches the closed input', () => {
    const h = makeHarness()
    const input = makeInput(h.inst, 's-gone', 'fake')
    h.groups.groupList[0]!.fireClose(input)
    expect(h.sessions.closed).toEqual([])
    h.contrib.dispose()
  })
})
