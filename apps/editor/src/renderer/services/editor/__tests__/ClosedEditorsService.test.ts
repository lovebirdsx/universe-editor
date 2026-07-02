/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ClosedEditorsService and the ReopenClosedEditorAction that consumes it.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  EditorInput,
  EditorRegistry,
  Emitter,
  IEditorGroupsService,
  IFocusStackService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  registerAction2,
  type Event,
  type IFocusEntry,
  type PartId,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { ClosedEditorsService, IClosedEditorsService } from '../ClosedEditorsService.js'
import { ReopenClosedEditorAction } from '../../../actions/editorActions.js'

// ---------------------------------------------------------------------------
// Fake input types used by tests
// ---------------------------------------------------------------------------

class FakeVirtualInput extends EditorInput {
  static readonly TYPE_ID = 'fake.virtual.closed.test'
  private static _counter = 0

  private readonly _uri: string
  constructor(label = 'fake') {
    super()
    this._uri = `virtual:///${label}-${FakeVirtualInput._counter++}`
  }
  override get typeId() {
    return FakeVirtualInput.TYPE_ID
  }
  override get resource() {
    return URI.parse(this._uri)
  }
  override getName() {
    return 'FakeVirtual'
  }
  override serialize(): { uri: string } {
    return { uri: this._uri }
  }
  static deserialize(data: unknown): FakeVirtualInput {
    const inst = new FakeVirtualInput()
    // Restore URI from serialized data
    ;(inst as unknown as { _uri: string })._uri = (data as { uri: string }).uri
    return inst
  }
}

class FakeNoSerializeInput extends EditorInput {
  static readonly TYPE_ID = 'fake.noserialize.closed.test'
  constructor(private readonly _id: string) {
    super()
  }
  override get typeId() {
    return FakeNoSerializeInput.TYPE_ID
  }
  override get resource() {
    return URI.parse(`virtual:///noserialize-${this._id}`)
  }
  override getName() {
    return 'FakeNoSerialize'
  }
  // No serialize() — simulates WelcomeEditorInput, GitGraphEditorInput, etc.
  static deserialize(): FakeNoSerializeInput {
    return new FakeNoSerializeInput('restored')
  }
}

// ---------------------------------------------------------------------------
// Fake IFocusStackService
// ---------------------------------------------------------------------------

class FakeFocusStackService implements IFocusStackService {
  declare readonly _serviceBrand: undefined
  readonly onDidChange: Event<void> = new Emitter<void>().event
  push(_entry: Omit<IFocusEntry, 'timestamp'>): void {}
  getTop(): IFocusEntry | undefined {
    return undefined
  }
  getAll(): readonly IFocusEntry[] {
    return []
  }
  nextPart(): PartId | undefined {
    return undefined
  }
  previousPart(): PartId | undefined {
    return undefined
  }
  clear(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cleanupRegistry: Array<() => void> = []

beforeEach(() => {
  const d1 = EditorRegistry.registerEditorProvider({
    typeId: FakeVirtualInput.TYPE_ID,
    componentKey: 'fake.virtual',
    deserialize: (data) => FakeVirtualInput.deserialize(data),
  })
  const d2 = EditorRegistry.registerEditorProvider({
    typeId: FakeNoSerializeInput.TYPE_ID,
    componentKey: 'fake.noserialize',
    deserialize: () => FakeNoSerializeInput.deserialize(),
  })
  cleanupRegistry.push(
    () => d1.dispose(),
    () => d2.dispose(),
  )
})

afterEach(() => {
  for (const cleanup of cleanupRegistry) cleanup()
  cleanupRegistry = []
})

// ---------------------------------------------------------------------------
// ClosedEditorsService — stack behavior
// ---------------------------------------------------------------------------

describe('ClosedEditorsService — stack behavior', () => {
  it('popMostRecent returns undefined when no editor has been closed', () => {
    const groups = new EditorGroupsService()
    const svc = new ClosedEditorsService(groups, new UriIdentityService('linux'))
    expect(svc.popMostRecent()).toBeUndefined()
    svc.dispose()
    groups.dispose()
  })

  it('returns the most recently closed editor entry', () => {
    const groups = new EditorGroupsService()
    const svc = new ClosedEditorsService(groups, new UriIdentityService('linux'))
    const a = new FakeVirtualInput('a')
    const b = new FakeVirtualInput('b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    groups.activeGroup.closeEditor(b)

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.typeId).toBe(FakeVirtualInput.TYPE_ID)
    svc.dispose()
    groups.dispose()
  })

  it('captures typeId correctly for non-text (virtual) editors', () => {
    const groups = new EditorGroupsService()
    const svc = new ClosedEditorsService(groups, new UriIdentityService('linux'))
    const input = new FakeNoSerializeInput('x')
    groups.activeGroup.openEditor(input)
    groups.activeGroup.closeEditor(input)

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.typeId).toBe(FakeNoSerializeInput.TYPE_ID)
    svc.dispose()
    groups.dispose()
  })

  it('captures serializedData from editor.serialize() when implemented', () => {
    const groups = new EditorGroupsService()
    const svc = new ClosedEditorsService(groups, new UriIdentityService('linux'))
    const input = new FakeVirtualInput('ser')
    groups.activeGroup.openEditor(input)
    const expectedData = input.serialize()
    groups.activeGroup.closeEditor(input)

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.serializedData).toEqual(expectedData)
    svc.dispose()
    groups.dispose()
  })

  it('serializedData is null for editors without serialize()', () => {
    const groups = new EditorGroupsService()
    const svc = new ClosedEditorsService(groups, new UriIdentityService('linux'))
    const input = new FakeNoSerializeInput('noser')
    groups.activeGroup.openEditor(input)
    groups.activeGroup.closeEditor(input)

    const entry = svc.popMostRecent()
    expect(entry).toBeDefined()
    expect(entry!.serializedData).toBeNull()
    svc.dispose()
    groups.dispose()
  })

  it('popMostRecent skips entries whose editor is already open', () => {
    const groups = new EditorGroupsService()
    const svc = new ClosedEditorsService(groups, new UriIdentityService('linux'))
    const a = new FakeVirtualInput('skip-a')
    const b = new FakeVirtualInput('skip-b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    // Close b, then reopen it — b is now open again
    groups.activeGroup.closeEditor(b)
    groups.activeGroup.openEditor(b)
    // Also close a
    groups.activeGroup.closeEditor(a)

    // b is in the stack but already open, so popMostRecent should skip it and return a
    const entry = svc.popMostRecent()
    expect(entry!.typeId).toBe(FakeVirtualInput.TYPE_ID)
    expect(entry!.resource.toString()).toBe(a.resource.toString())
    svc.dispose()
    groups.dispose()
  })

  it('stack is LIFO — most recently closed comes first', () => {
    const groups = new EditorGroupsService()
    const svc = new ClosedEditorsService(groups, new UriIdentityService('linux'))
    const a = new FakeVirtualInput('lifo-a')
    const b = new FakeVirtualInput('lifo-b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    groups.activeGroup.closeEditor(a)
    groups.activeGroup.closeEditor(b)

    // b was closed last, so it should come first
    const first = svc.popMostRecent()
    expect(first!.resource.toString()).toBe(b.resource.toString())
    const second = svc.popMostRecent()
    expect(second!.resource.toString()).toBe(a.resource.toString())
    svc.dispose()
    groups.dispose()
  })
})

// ---------------------------------------------------------------------------
// ReopenClosedEditorAction — uses EditorRegistry.deserialize, not FileEditorInput
// ---------------------------------------------------------------------------

describe('ReopenClosedEditorAction', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    disposables.push(registerAction2(ReopenClosedEditorAction))
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function makeHarness() {
    const groups = new EditorGroupsService()
    const closedSvc = new ClosedEditorsService(groups, new UriIdentityService('linux'))
    const focusSvc = new FakeFocusStackService()

    const services = new ServiceCollection()
    services.set(IEditorGroupsService, groups)
    services.set(IClosedEditorsService, closedSvc)
    services.set(IFocusStackService, focusSvc)
    const inst = new InstantiationService(services)

    return { groups, closedSvc, inst }
  }

  function runAction(harness: ReturnType<typeof makeHarness>): void {
    const cmd = CommandsRegistry.getCommand(ReopenClosedEditorAction.ID)
    if (!cmd) throw new Error('ReopenClosedEditorAction not registered')
    harness.inst.invokeFunction((accessor) => cmd.handler(accessor))
  }

  it('does nothing when the closed-editors stack is empty', () => {
    const h = makeHarness()
    // Should not throw
    runAction(h)
    expect(h.groups.activeGroup.editors).toHaveLength(0)
    h.groups.dispose()
    h.closedSvc.dispose()
  })

  it('reopens a non-text editor with the correct typeId (bug: was FileEditorInput)', () => {
    const h = makeHarness()
    const input = new FakeVirtualInput('reopen')
    h.groups.activeGroup.openEditor(input)
    h.groups.activeGroup.closeEditor(input)
    // Stack now has the entry with typeId=FakeVirtualInput.TYPE_ID

    runAction(h)

    const reopened = h.groups.activeGroup.activeEditor
    expect(reopened).toBeDefined()
    expect(reopened!.typeId).toBe(FakeVirtualInput.TYPE_ID)
    h.groups.dispose()
    h.closedSvc.dispose()
  })

  it('reopens a non-serialize editor with the correct typeId', () => {
    const h = makeHarness()
    const input = new FakeNoSerializeInput('noser-reopen')
    h.groups.activeGroup.openEditor(input)
    h.groups.activeGroup.closeEditor(input)

    runAction(h)

    const reopened = h.groups.activeGroup.activeEditor
    expect(reopened).toBeDefined()
    expect(reopened!.typeId).toBe(FakeNoSerializeInput.TYPE_ID)
    h.groups.dispose()
    h.closedSvc.dispose()
  })

  it('skips an entry when EditorRegistry has no deserialize for that typeId', () => {
    // Simulate a TerminalEditorInput (no deserialize registered)
    class NoDeserializeInput extends EditorInput {
      static readonly TYPE_ID = 'fake.nodeserialize'
      override get typeId() {
        return NoDeserializeInput.TYPE_ID
      }
      override get resource() {
        return URI.parse('virtual:///nodeserialize')
      }
      override getName() {
        return 'NoDeserialize'
      }
    }

    // Register without a deserialize hook
    const d = EditorRegistry.registerEditorProvider({
      typeId: NoDeserializeInput.TYPE_ID,
      componentKey: 'fake.nodeserialize',
      // No deserialize
    })

    const h = makeHarness()
    const input = new NoDeserializeInput()
    h.groups.activeGroup.openEditor(input)
    h.groups.activeGroup.closeEditor(input)

    runAction(h)

    // Nothing should be reopened — entry was skipped
    expect(h.groups.activeGroup.activeEditor).toBeUndefined()
    d.dispose()
    h.groups.dispose()
    h.closedSvc.dispose()
  })
})
