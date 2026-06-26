/*---------------------------------------------------------------------------------------------
 *  Tests for AgentsActiveSessionSyncContribution — focusing a session editor tab
 *  retargets IAcpSessionService.activeSession to that session, so session-scoped
 *  UI (Session Changes, status bar) tracks the editor in front of the user.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type IEditorInput,
  type IEditorService,
  type ISettableObservable,
} from '@universe-editor/platform'
import { AgentsActiveSessionSyncContribution } from '../AgentsContributions.js'
import { AcpSessionEditorInput } from '../../services/acp/acpSessionEditorInput.js'
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

class FakeEditorService {
  declare readonly _serviceBrand: undefined
  readonly activeEditor: ISettableObservable<IEditorInput | undefined> = observableValue(
    'fake.activeEditor',
    undefined,
  )
}

class FakeSessionService {
  declare readonly _serviceBrand: undefined
  readonly activeSessionId: ISettableObservable<string | undefined> = observableValue(
    'fake.activeSessionId',
    undefined,
  )
  readonly setActiveCalls: string[] = []
  private readonly _byId = new Map<string, IAcpSession>()
  register(id: string): void {
    this._byId.set(id, {
      id,
      agentId: 'fake',
      title: id,
      sessionIdOnAgent: observableValue<string | undefined>('fake.sid', id),
    } as unknown as IAcpSession)
  }
  getById(id: string): IAcpSession | undefined {
    return this._byId.get(id)
  }
  setActive(id: string): void {
    this.setActiveCalls.push(id)
    this.activeSessionId.set(id, undefined)
  }
}

function makeInput(inst: IInstantiationService, sessionId: string) {
  return inst.createInstance(AcpSessionEditorInput, sessionId, 'fake', undefined)
}

function makeHarness() {
  const editor = new FakeEditorService()
  const sessions = new FakeSessionService()
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
  const contrib = new AgentsActiveSessionSyncContribution(
    editor as unknown as IEditorService,
    sessions as unknown as IAcpSessionServiceType,
  )
  return { editor, sessions, inst, contrib }
}

describe('AgentsActiveSessionSyncContribution', () => {
  it('retargets activeSession when a live session editor is focused', () => {
    const h = makeHarness()
    h.sessions.register('s2')
    h.editor.activeEditor.set(makeInput(h.inst, 's2'), undefined)
    expect(h.sessions.setActiveCalls).toEqual(['s2'])
    h.contrib.dispose()
  })

  it('switches the pointer when focus moves between two session editors', () => {
    const h = makeHarness()
    h.sessions.register('s1')
    h.sessions.register('s2')
    h.editor.activeEditor.set(makeInput(h.inst, 's1'), undefined)
    h.editor.activeEditor.set(makeInput(h.inst, 's2'), undefined)
    expect(h.sessions.setActiveCalls).toEqual(['s1', 's2'])
    h.contrib.dispose()
  })

  it('ignores non-session editors', () => {
    const h = makeHarness()
    h.editor.activeEditor.set({ id: 'file:foo' } as unknown as IEditorInput, undefined)
    expect(h.sessions.setActiveCalls).toEqual([])
    h.contrib.dispose()
  })

  it('leaves the pointer alone for a not-yet-resumed session', () => {
    const h = makeHarness()
    // No register() — session is not live yet.
    h.editor.activeEditor.set(makeInput(h.inst, 's-pending'), undefined)
    expect(h.sessions.setActiveCalls).toEqual([])
    h.contrib.dispose()
  })

  it('does not re-set when the focused session is already active', () => {
    const h = makeHarness()
    h.sessions.register('s1')
    h.sessions.activeSessionId.set('s1', undefined)
    h.editor.activeEditor.set(makeInput(h.inst, 's1'), undefined)
    expect(h.sessions.setActiveCalls).toEqual([])
    h.contrib.dispose()
  })

  it('does not revert activeSessionId when setActive is called externally while editor stays on the previous tab', () => {
    // Regression: autorun subscribed to activeSessionId.read(r) which caused it
    // to re-run on every setActive call, see activeEditor still pointing at the
    // old tab, and call setActive back — undoing the switch on first click.
    const h = makeHarness()
    h.sessions.register('s1')
    h.sessions.register('s2')
    // Focus s1 — autorun fires and syncs activeSessionId to s1.
    h.editor.activeEditor.set(makeInput(h.inst, 's1'), undefined)
    expect(h.sessions.activeSessionId.get()).toBe('s1')

    // AGENTS panel click: setActive('s2') must not be reverted by the autorun
    // seeing activeEditor still on s1 and calling setActive('s1') again.
    h.sessions.setActive('s2')
    expect(h.sessions.activeSessionId.get()).toBe('s2')
    expect(h.sessions.setActiveCalls).toEqual(['s1', 's2'])
    h.contrib.dispose()
  })
})
