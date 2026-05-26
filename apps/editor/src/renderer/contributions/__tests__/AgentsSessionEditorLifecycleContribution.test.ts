/*---------------------------------------------------------------------------------------------
 *  Tests for AgentsSessionEditorLifecycleContribution — verifies that closing
 *  an AcpSessionEditorInput tab stops the live agent session, except during
 *  AcpChatLocationService migrations or when the input is still open in
 *  another group.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  Emitter,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupsService,
  type IObservable,
  observableValue,
} from '@universe-editor/platform'
import { AgentsSessionEditorLifecycleContribution } from '../AgentsContributions.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
import type {
  IAcpChatLocationService,
  AcpChatLocation,
} from '../../services/acp/acpChatLocationService.js'
import type { IAcpSession, IAcpSessionService } from '../../services/acp/acpSessionService.js'
import type { IEditorGroupModelChangeEvent } from '@universe-editor/platform'

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
  private readonly _byHistoryId = new Map<string, IAcpSession>()
  register(session: IAcpSession): void {
    this._byId.set(session.id, session)
    if (session.historyId) this._byHistoryId.set(session.historyId, session)
  }
  getById(id: string): IAcpSession | undefined {
    return this._byId.get(id)
  }
  getByHistoryId(id: string): IAcpSession | undefined {
    return this._byHistoryId.get(id)
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

function makeSession(id: string, agentId: string, historyId?: string): IAcpSession {
  return { id, agentId, title: id, historyId } as unknown as IAcpSession
}

interface Harness {
  groups: FakeEditorGroupsService
  sessions: FakeSessionService
  location: FakeLocationService
  contrib: AgentsSessionEditorLifecycleContribution
}

function makeHarness(): Harness {
  const groups = new FakeEditorGroupsService()
  const sessions = new FakeSessionService()
  const location = new FakeLocationService()
  const contrib = new AgentsSessionEditorLifecycleContribution(
    groups as unknown as IEditorGroupsService,
    sessions as unknown as IAcpSessionService,
    location as unknown as IAcpChatLocationService,
  )
  return { groups, sessions, location, contrib }
}

describe('AgentsSessionEditorLifecycleContribution', () => {
  it('closes the live session when an AcpSessionEditorInput tab is closed', () => {
    const h = makeHarness()
    h.sessions.register(makeSession('s1', 'fake', 'h1'))
    const input = new AcpSessionEditorInput('s1', 'fake', 'h1')
    h.groups.groupList[0]!.fireClose(input)
    expect(h.sessions.closed).toEqual(['s1'])
    h.contrib.dispose()
  })

  it('prefers historyId resolution when sessionId is stale (post-resume)', () => {
    const h = makeHarness()
    // Live session has a fresh local id but maps to the same historyId.
    h.sessions.register(makeSession('s99', 'fake', 'h1'))
    const input = new AcpSessionEditorInput('s1-stale', 'fake', 'h1')
    h.groups.groupList[0]!.fireClose(input)
    expect(h.sessions.closed).toEqual(['s99'])
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
    h.sessions.register(makeSession('s1', 'fake', 'h1'))
    h.location.isMigrating = true
    const input = new AcpSessionEditorInput('s1', 'fake', 'h1')
    h.groups.groupList[0]!.fireClose(input)
    expect(h.sessions.closed).toEqual([])
    h.contrib.dispose()
  })

  it('does not stop a session whose input is still open in another group', () => {
    const h = makeHarness()
    h.sessions.register(makeSession('s1', 'fake', 'h1'))
    const input = new AcpSessionEditorInput('s1', 'fake', 'h1')
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
    h.sessions.register(makeSession('s2', 'fake', 'h2'))
    const g2 = h.groups.addGroup()
    const input = new AcpSessionEditorInput('s2', 'fake', 'h2')
    g2.fireClose(input)
    expect(h.sessions.closed).toEqual(['s2'])
    h.contrib.dispose()
  })

  it('no-ops when no live session matches the closed input', () => {
    const h = makeHarness()
    const input = new AcpSessionEditorInput('s-gone', 'fake', 'h-gone')
    h.groups.groupList[0]!.fireClose(input)
    expect(h.sessions.closed).toEqual([])
    h.contrib.dispose()
  })
})
