/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpChatLocationService.ts
 *
 *  Exercises the three-way sync (Observable + ContextKey + Storage) and the
 *  setLocation side effects (closes/opens AcpSessionEditorInput tabs). Uses a
 *  real ContextKeyService so we can read the persisted key back. EditorService
 *  / EditorGroupsService / AcpSessionService are minimal hand-rolled stubs.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  Event,
  InstantiationService,
  LogLevel,
  NoopTelemetryService,
  NullLogger,
  ServiceCollection,
  StorageScope,
  observableValue,
  type EditorInput,
  type IContextKeyService,
  type IEditorGroup,
  type IEditorGroupsService,
  type IEditorService,
  type IInstantiationService,
  type ILogger,
  type ILoggerService,
  type IObservable,
  type IStorageService,
} from '@universe-editor/platform'
import { AcpChatLocationService } from '../acpChatLocationService.js'
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

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly store = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }
}

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

class FakeGroup {
  readonly id: number = 0
  readonly editors: EditorInput[] = []
  readonly closed: EditorInput[] = []
  closeEditor(editor: EditorInput): boolean {
    const i = this.editors.indexOf(editor)
    if (i === -1) return false
    this.editors.splice(i, 1)
    this.closed.push(editor)
    return true
  }
}

class FakeEditorGroupsService {
  declare readonly _serviceBrand: undefined
  readonly groupList: FakeGroup[] = [new FakeGroup()]
  activeGroupIndex = 0
  get groups(): readonly IEditorGroup[] {
    return this.groupList as unknown as readonly IEditorGroup[]
  }
  get activeGroup(): IEditorGroup {
    return this.groupList[this.activeGroupIndex] as unknown as IEditorGroup
  }
}

class FakeEditorService {
  declare readonly _serviceBrand: undefined
  readonly opened: EditorInput[] = []
  constructor(private readonly _groups?: FakeEditorGroupsService) {}
  openEditor(input: EditorInput): void {
    this.opened.push(input)
    // Mirror EditorService.openEditor: dedup is scoped to the ACTIVE group only.
    // A same-id editor living in a non-active group is invisible here, so the
    // input lands as a fresh tab in the active group.
    const active = this._groups?.activeGroup as unknown as FakeGroup | undefined
    if (!active) return
    const existing = active.editors.find((e) => e.id === input.id)
    if (!existing) active.editors.push(input)
  }
  closeEditor(_id: string): void {}
}

class FakeSessionService {
  declare readonly _serviceBrand: undefined
  readonly activeSessionObs = observableValue<IAcpSession | undefined>(
    'test.activeSession',
    undefined,
  )
  readonly activeSession: IObservable<IAcpSession | undefined> = this.activeSessionObs
  setActiveSession(s: IAcpSession | undefined): void {
    this.activeSessionObs.set(s, undefined)
  }
  getById(id: string): IAcpSession | undefined {
    const active = this.activeSessionObs.get()
    return active && active.id === id ? active : undefined
  }
}

function makeSession(id: string, agentId: string): IAcpSession {
  return {
    id,
    agentId,
    title: 'Test',
    sessionIdOnAgent: observableValue<string | undefined>('test.sid', id),
  } as unknown as IAcpSession
}

interface Harness {
  svc: AcpChatLocationService
  storage: FakeStorage
  ctx: ContextKeyService
  editor: FakeEditorService
  groups: FakeEditorGroupsService
  sessions: FakeSessionService
  inst: IInstantiationService
}

function makeHarness(storage: FakeStorage = new FakeStorage()): Harness {
  const ctx = new ContextKeyService()
  const groups = new FakeEditorGroupsService()
  const editor = new FakeEditorService(groups)
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
  const svc = new AcpChatLocationService(
    storage,
    ctx as unknown as IContextKeyService,
    editor as unknown as IEditorService,
    groups as unknown as IEditorGroupsService,
    sessions as unknown as IAcpSessionServiceType,
    new NoopTelemetryService(),
    new StubLoggerService(),
    inst,
  )
  return { svc, storage, ctx, editor, groups, sessions, inst }
}

/** Drain the 100ms debounce + the async set() microtask. */
async function flushWrite(): Promise<void> {
  await new Promise((r) => setTimeout(r, 130))
}

describe('AcpChatLocationService — defaults', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.svc.dispose())

  it("defaults to 'editor' before initialize resolves and after empty storage load", async () => {
    expect(h.svc.location.get()).toBe('editor')
    expect(h.ctx.get('acpChatLocation')).toBe('editor')
    await h.svc.initialize()
    expect(h.svc.location.get()).toBe('editor')
  })

  it('initialize is idempotent', async () => {
    await h.svc.initialize()
    await h.svc.initialize() // should be no-op, no throw
    expect(h.svc.location.get()).toBe('editor')
  })

  it('restores a persisted sidebar value', async () => {
    const storage = new FakeStorage()
    storage.store.set('acp.chatLocation', { schemaVersion: 1, location: 'sidebar' })
    const harness = makeHarness(storage)
    await harness.svc.initialize()
    expect(harness.svc.location.get()).toBe('sidebar')
    expect(harness.ctx.get('acpChatLocation')).toBe('sidebar')
    harness.svc.dispose()
  })

  it('ignores stored payloads with a foreign schemaVersion', async () => {
    const storage = new FakeStorage()
    storage.store.set('acp.chatLocation', { schemaVersion: 999, location: 'sidebar' })
    const harness = makeHarness(storage)
    await harness.svc.initialize()
    expect(harness.svc.location.get()).toBe('editor')
    harness.svc.dispose()
  })
})

describe('AcpChatLocationService — setLocation', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })
  afterEach(() => h.svc.dispose())

  it('updates observable + context key + persists to storage', async () => {
    await h.svc.initialize()
    h.svc.setLocation('sidebar')
    expect(h.svc.location.get()).toBe('sidebar')
    expect(h.ctx.get('acpChatLocation')).toBe('sidebar')
    await flushWrite()
    expect(h.storage.store.get('acp.chatLocation')).toEqual({
      schemaVersion: 1,
      location: 'sidebar',
    })
  })

  it('setting the same location is a no-op (no extra write, no side effect)', async () => {
    await h.svc.initialize()
    h.svc.setLocation('editor') // same as default
    await flushWrite()
    expect(h.storage.store.has('acp.chatLocation')).toBe(false)
    expect(h.editor.opened).toHaveLength(0)
  })

  it('toggle flips between editor and sidebar', async () => {
    await h.svc.initialize()
    h.svc.toggle()
    expect(h.svc.location.get()).toBe('sidebar')
    h.svc.toggle()
    expect(h.svc.location.get()).toBe('editor')
  })
})

describe('AcpChatLocationService — side effects', () => {
  it("setLocation('sidebar') closes every AcpSessionEditorInput across all groups", async () => {
    const h = makeHarness()
    await h.svc.initialize()
    const fileInput = { id: 'file:foo' } as unknown as EditorInput
    const acpA = h.inst.createInstance(AcpSessionEditorInput, 's1', 'fake', undefined)
    const acpB = h.inst.createInstance(AcpSessionEditorInput, 's2', 'fake', undefined)
    h.groups.groupList[0]!.editors.push(fileInput, acpA)
    // Second group with another ACP tab.
    const g2 = new FakeGroup()
    g2.editors.push(acpB)
    h.groups.groupList.push(g2)

    h.svc.setLocation('sidebar')

    expect(h.groups.groupList[0]!.closed).toEqual([acpA])
    expect(h.groups.groupList[1]!.closed).toEqual([acpB])
    expect(h.groups.groupList[0]!.editors).toEqual([fileInput])
    h.svc.dispose()
  })

  it("setLocation('editor') opens the active session as a tab when present", async () => {
    const h = makeHarness()
    await h.svc.initialize()
    // Start in sidebar so the next flip triggers the editor side effect.
    h.svc.setLocation('sidebar')
    expect(h.editor.opened).toHaveLength(0)
    h.sessions.setActiveSession(makeSession('s1', 'fake'))
    h.svc.setLocation('editor')
    expect(h.editor.opened).toHaveLength(1)
    const opened = h.editor.opened[0] as AcpSessionEditorInput
    expect(opened.sessionId).toBe('s1')
    expect(opened.agentId).toBe('fake')
    h.svc.dispose()
  })

  it("setLocation('editor') is a no-op for editor.openEditor when no session is active", async () => {
    const h = makeHarness()
    await h.svc.initialize()
    h.svc.setLocation('sidebar')
    h.svc.setLocation('editor')
    expect(h.editor.opened).toHaveLength(0)
    h.svc.dispose()
  })

  it('switching active session after entering editor mode opens the new session as a tab', async () => {
    // Regression: sidebar → pick A → switch to editor (A becomes a tab) →
    // pick B in the sidebar list. B must follow into the editor area.
    // Previously the activeSession autorun was gated by a non-observable
    // `this._location` field — when the service was first constructed in
    // sidebar mode the autorun's early-return path dropped its subscription
    // to activeSession, so later `setActive` calls never re-ran the open.
    const storage = new FakeStorage()
    storage.store.set('acp.chatLocation', { schemaVersion: 1, location: 'sidebar' })
    const h = makeHarness(storage)
    await h.svc.initialize()
    expect(h.svc.location.get()).toBe('sidebar')

    // 1. User picks session A while in sidebar mode (nothing opens in editor).
    h.sessions.setActiveSession(makeSession('s1', 'fake'))
    expect(h.editor.opened).toHaveLength(0)

    // 2. Switch to editor mode → A opens as an editor tab.
    h.svc.setLocation('editor')
    expect(h.editor.opened).toHaveLength(1)
    expect((h.editor.opened[0] as AcpSessionEditorInput).sessionId).toBe('s1')

    // 3. User picks session B from the sidebar list — must open as an editor tab.
    h.sessions.setActiveSession(makeSession('s2', 'fake'))
    expect(h.editor.opened).toHaveLength(2)
    expect((h.editor.opened[1] as AcpSessionEditorInput).sessionId).toBe('s2')

    h.svc.dispose()
  })

  it('activeSession changes while in editor mode keep opening new tabs', async () => {
    // Companion to the regression above: even when the service starts
    // already in 'editor' mode, swapping active session must keep opening
    // tabs for each new sessionId.
    const h = makeHarness()
    await h.svc.initialize()
    expect(h.svc.location.get()).toBe('editor')

    h.sessions.setActiveSession(makeSession('s1', 'fake'))
    expect(h.editor.opened).toHaveLength(1)
    expect((h.editor.opened[0] as AcpSessionEditorInput).sessionId).toBe('s1')

    h.sessions.setActiveSession(makeSession('s2', 'fake'))
    expect(h.editor.opened).toHaveLength(2)
    expect((h.editor.opened[1] as AcpSessionEditorInput).sessionId).toBe('s2')

    h.svc.dispose()
  })

  it('activeSession changes while in sidebar mode do NOT open editor tabs', async () => {
    const storage = new FakeStorage()
    storage.store.set('acp.chatLocation', { schemaVersion: 1, location: 'sidebar' })
    const h = makeHarness(storage)
    await h.svc.initialize()

    h.sessions.setActiveSession(makeSession('s1', 'fake'))
    h.sessions.setActiveSession(makeSession('s2', 'fake'))
    expect(h.editor.opened).toHaveLength(0)

    h.svc.dispose()
  })

  it('does NOT duplicate a restored session into the active group when it already lives in another group', async () => {
    // Regression: restart with a split layout where the session editor was
    // restored into a NON-active group (left) and a plain file editor sits in
    // the active group (right). On restore the session resumes → activeSession
    // is set → the location autorun fires openEditor. Because EditorService's
    // dedup is scoped to the active group, it could not see the session already
    // living in the left group and duplicated it into the right (active) group.
    const h = makeHarness()
    await h.svc.initialize()
    expect(h.svc.location.get()).toBe('editor')

    // Left group (index 0): the restored session tab.
    const leftGroup = h.groups.groupList[0]!
    const restored = h.inst.createInstance(AcpSessionEditorInput, 's1', 'fake', undefined)
    leftGroup.editors.push(restored)

    // Right group (index 1) is active and holds only a plain file editor.
    const rightGroup = new FakeGroup()
    ;(rightGroup as { id: number }).id = 1
    const fileInput = { id: 'file:foo' } as unknown as EditorInput
    rightGroup.editors.push(fileInput)
    h.groups.groupList.push(rightGroup)
    h.groups.activeGroupIndex = 1

    // Resume sets the active session (id === durable sessionId 's1').
    h.sessions.setActiveSession(makeSession('s1', 'fake'))

    // The session must NOT be copied into the active (right) group.
    expect(rightGroup.editors.map((e) => e.id)).toEqual(['file:foo'])
    // And it must still exist exactly once, in the left group.
    const total = h.groups.groupList
      .flatMap((g) => g.editors)
      .filter((e) => e instanceof AcpSessionEditorInput)
    expect(total).toHaveLength(1)
    expect(leftGroup.editors).toContain(restored)

    h.svc.dispose()
  })

  it('isMigrating is true only while side effects run, false outside', async () => {
    const h = makeHarness()
    await h.svc.initialize()
    expect(h.svc.isMigrating).toBe(false)

    // Push an ACP tab whose closeEditor we instrument to observe isMigrating mid-flight.
    const acp = h.inst.createInstance(AcpSessionEditorInput, 's1', 'fake', undefined)
    const seen: boolean[] = []
    const group = h.groups.groupList[0]!
    group.editors.push(acp)
    const origClose = group.closeEditor.bind(group)
    group.closeEditor = (e: EditorInput) => {
      seen.push(h.svc.isMigrating)
      return origClose(e)
    }

    h.svc.setLocation('sidebar')
    expect(seen).toEqual([true])
    expect(h.svc.isMigrating).toBe(false)
    h.svc.dispose()
  })
})
