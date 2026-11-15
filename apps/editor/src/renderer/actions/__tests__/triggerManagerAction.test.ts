/*---------------------------------------------------------------------------------------------
 *  Tests for OpenTriggerManagerAction: every invocation lands in one manager tab
 *  (the editor input's fixed identity dedupes it) and a later trigger key is
 *  handed to the already-mounted tab through `updateFrom`.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  GroupDirection,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'
import { TriggerManagerEditorInput } from '../../services/triggers/triggerManagerEditorInput.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { OpenTriggerManagerAction } from '../triggerActions.js'

function makeHarness() {
  const groups = new EditorGroupsService()
  const rescanWorkspace = vi.fn(async () => undefined)
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IAuxiliaryEditorWindowService, {} as unknown as IAuxiliaryEditorWindowService)
  services.set(IUriIdentityService, {
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  } as unknown as IUriIdentityService)
  services.set(ITriggerMainService, {
    _serviceBrand: undefined,
    rescanWorkspace,
  } as unknown as ITriggerMainService)
  services.set(IWorkspaceService, {
    _serviceBrand: undefined,
    current: { folder: URI.file('X:/workspace') },
  } as unknown as IWorkspaceService)
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => ({ warn: vi.fn() }),
  } as unknown as ILoggerService)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return { groups, inst, rescanWorkspace }
}

describe('OpenTriggerManagerAction', () => {
  it('opens the manager tab with no selection', async () => {
    const { groups, inst } = makeHarness()

    await inst.invokeFunction((accessor) => new OpenTriggerManagerAction().run(accessor))

    const editors = groups.activeGroup.editors
    expect(editors).toHaveLength(1)
    expect(editors[0]).toBeInstanceOf(TriggerManagerEditorInput)
    expect((editors[0] as TriggerManagerEditorInput).consumePendingSelection()).toBeUndefined()
  })

  it('reuses the single tab and transfers the pending trigger key', async () => {
    const { groups, inst } = makeHarness()

    await inst.invokeFunction((accessor) =>
      new OpenTriggerManagerAction().run(accessor, 'ws-a\u0000triage'),
    )
    await inst.invokeFunction((accessor) =>
      new OpenTriggerManagerAction().run(accessor, 'ws-b\u0000weekly'),
    )

    const editors = groups.activeGroup.editors
    expect(editors).toHaveLength(1)
    const input = editors[0] as TriggerManagerEditorInput
    expect(input).toBeInstanceOf(TriggerManagerEditorInput)
    // The first key was replaced by the duplicate open's key before anyone consumed it.
    expect(input.consumePendingSelection()).toBe('ws-b\u0000weekly')
  })

  it('announces a transferred key so a mounted view can reveal it', async () => {
    const { groups, inst } = makeHarness()
    await inst.invokeFunction((accessor) =>
      new OpenTriggerManagerAction().run(accessor, 'ws-a\u0000triage'),
    )
    const input = groups.activeGroup.editors[0] as TriggerManagerEditorInput
    const seen: string[] = []
    const subscription = input.onDidChangeSelection((key) => seen.push(key))

    await inst.invokeFunction((accessor) =>
      new OpenTriggerManagerAction().run(accessor, 'ws-c\u0000later'),
    )

    expect(seen).toEqual(['ws-c\u0000later'])
    subscription.dispose()
  })

  it('reveals the existing tab instead of opening a second copy in a split group', async () => {
    const { groups, inst } = makeHarness()
    await inst.invokeFunction((accessor) =>
      new OpenTriggerManagerAction().run(accessor, 'ws-a\u0000triage'),
    )
    const originalGroup = groups.activeGroup
    const input = originalGroup.editors[0] as TriggerManagerEditorInput
    const splitGroup = groups.addGroup(originalGroup, GroupDirection.Right)
    groups.activateGroup(splitGroup)
    expect(groups.activeGroup).toBe(splitGroup)

    const seen: string[] = []
    const subscription = input.onDidChangeSelection((key) => seen.push(key))
    await inst.invokeFunction((accessor) =>
      new OpenTriggerManagerAction().run(accessor, 'ws-b\u0000weekly'),
    )

    expect(groups.groups).toHaveLength(2)
    expect(splitGroup.editors).toHaveLength(0)
    expect(originalGroup.editors).toEqual([input])
    expect(groups.activeGroup).toBe(originalGroup)
    expect(seen).toEqual(['ws-b\u0000weekly'])
    subscription.dispose()
  })

  it('rescans the calling window workspace on first and repeat opens', async () => {
    const { inst, rescanWorkspace } = makeHarness()
    const workspace = URI.file('X:/workspace').toString()

    await inst.invokeFunction((accessor) => new OpenTriggerManagerAction().run(accessor))
    await vi.waitFor(() => expect(rescanWorkspace).toHaveBeenCalledWith(workspace))

    // The tab exists now; the reveal/early-return path must rescan too.
    await inst.invokeFunction((accessor) => new OpenTriggerManagerAction().run(accessor))
    await vi.waitFor(() => expect(rescanWorkspace).toHaveBeenCalledTimes(2))
  })
})
