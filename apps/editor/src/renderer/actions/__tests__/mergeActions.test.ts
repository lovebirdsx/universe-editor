import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  Emitter,
  ICommandService,
  IContextKeyService,
  IEditorGroupsService,
  IFileService,
  IInstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { OpenMergeEditorAction, type OpenMergeEditorPayload } from '../mergeActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { MergeEditorInput } from '../../services/editor/MergeEditorInput.js'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { FakeWindowFocusService } from '../../services/windows/testing/fakeWindowFocusService.js'
import {
  IAuxiliaryEditorWindowService,
  type OpenEditorInNewWindowResult,
} from '../../services/windows/auxiliaryEditorWindowService.js'

vi.mock('../../services/editor/editorFocus.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/editor/editorFocus.js')>()),
  focusEditorInput: vi.fn(() => true),
}))

class FakeAuxiliaryEditorWindowService {
  declare readonly _serviceBrand: undefined
  fail = false

  async openEditorInNewWindow(): Promise<OpenEditorInNewWindowResult> {
    if (this.fail) return { ok: false, reason: 'error' }
    return { ok: true, window: {} as never, editor: {} as never }
  }
}

function makeWorkspaceService(): IWorkspaceServiceType {
  const current: IWorkspace | null = null
  return {
    _serviceBrand: undefined,
    current,
    recent: [],
    onDidChangeWorkspace: new Emitter<IWorkspace | null>().event,
    onDidChangeRecent: new Emitter<readonly []>().event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {},
    async removeRecent() {},
    async clearRecent() {},
  } as IWorkspaceServiceType
}

function buildServices(
  groups: EditorGroupsService,
): InstantiationService & { aux: FakeAuxiliaryEditorWindowService; focus: FakeWindowFocusService } {
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IWorkspaceService, makeWorkspaceService())
  services.set(IFileService, {} as never)
  services.set(ICommandService, { executeCommand: async () => undefined } as never)
  services.set(IContextKeyService, new ContextKeyService())
  const focus = new FakeWindowFocusService()
  services.set(IWindowFocusService, focus as never)
  services.set(IUriIdentityService, {
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  } as never)
  const aux = new FakeAuxiliaryEditorWindowService()
  services.set(IAuxiliaryEditorWindowService, aux as never)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return Object.assign(inst, { aux, focus })
}

function payload(overrides?: Partial<OpenMergeEditorPayload>): OpenMergeEditorPayload {
  return {
    path: '/ws/a.txt',
    base: 'base',
    current: 'current',
    incoming: 'incoming',
    merged: 'merged',
    currentLabel: 'HEAD',
    incomingLabel: 'feature',
    ...overrides,
  }
}

function runOpenMerge(inst: InstantiationService, p: OpenMergeEditorPayload): void {
  const cmd = CommandsRegistry.getCommand(OpenMergeEditorAction.ID)!
  inst.invokeFunction((accessor) => cmd.handler(accessor, p))
}

describe('OpenMergeEditorAction — reveal on reopen', () => {
  const disposables: Array<{ dispose(): void }> = []

  beforeEach(() => {
    disposables.push(registerAction2(OpenMergeEditorAction))
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('reveals an existing merge editor when the new-window fallback runs after run() returned', async () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)
    runOpenMerge(inst, payload())
    const group = groups.activeGroup
    expect(group.editors[0]).toBeInstanceOf(MergeEditorInput)
    inst.focus.focusedGroups.length = 0
    inst.aux.fail = true

    // The async fallback runs after `run()` returned; it must not touch the
    // already-expired ServicesAccessor when revealing the existing tab.
    runOpenMerge(inst, payload({ openTarget: 'newWindow', merged: 'merged-2' }))

    await vi.waitFor(() => expect(inst.focus.focusedGroups).toEqual([group]))
    expect(group.editors).toHaveLength(1)
    expect((group.editors[0] as MergeEditorInput).contents.merged).toBe('merged-2')
  })

  it('reveals an existing merge editor reused by a side open', () => {
    const groups = new EditorGroupsService()
    const inst = buildServices(groups)
    const active = groups.activeGroup

    runOpenMerge(inst, payload({ openTarget: 'side' }))
    const side = groups.activeGroup
    groups.activateGroup(active)
    inst.focus.focusedGroups.length = 0

    runOpenMerge(inst, payload({ openTarget: 'side', merged: 'merged-2' }))

    expect(groups.count).toBe(2)
    expect(side.editors).toHaveLength(1)
    expect(inst.focus.focusedGroups).toEqual([side])
  })
})
