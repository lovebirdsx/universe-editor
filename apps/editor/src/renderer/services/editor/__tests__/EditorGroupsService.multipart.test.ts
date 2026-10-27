/*---------------------------------------------------------------------------------------------
 *  Tests for the multi-part editor model: global aggregation, part/global
 *  activation, cross-part moves/copies and per-part layout state.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  autorun,
  EditorInput,
  EditorRegistry,
  GroupDirection,
  GroupLocation,
  GroupsOrder,
  URI,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { EditorService } from '../EditorService.js'

class TestInput extends EditorInput {
  constructor(
    private readonly _resource: URI,
    private readonly _name: string,
  ) {
    super()
  }
  get typeId(): string {
    return 'multipart.test'
  }
  get resource(): URI {
    return this._resource
  }
  getName(): string {
    return this._name
  }
}

class PersistInput extends EditorInput {
  static readonly TYPE_ID = 'multipart.persist'
  static deserialize(): PersistInput {
    return new PersistInput()
  }
  get typeId(): string {
    return PersistInput.TYPE_ID
  }
  get resource(): URI {
    return URI.from({ scheme: 'multipart-persist', path: '/one' })
  }
  getName(): string {
    return 'Persist'
  }
}

function make(name: string): TestInput {
  return new TestInput(URI.file(`D:/${name}.txt`), name)
}

describe('EditorGroupsService — parts', () => {
  it('starts with one main part whose group is globally enumerable', () => {
    const svc = new EditorGroupsService()
    expect(svc.parts).toEqual([svc.mainPart])
    expect(svc.activePart).toBe(svc.mainPart)
    expect(svc.mainPart.isMain).toBe(true)
    expect(svc.groups).toEqual([svc.mainPart.activeGroup])
    expect(svc.count).toBe(1)
    expect(svc.getGroup(svc.mainPart.activeGroup.id)).toBe(svc.mainPart.activeGroup)
  })

  it('aggregates groups across parts in global creation order', () => {
    const svc = new EditorGroupsService()
    const mainGroup = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })
    const auxGroup = aux.activeGroup

    expect(svc.parts).toEqual([svc.mainPart, aux])
    expect(svc.groups).toEqual([mainGroup, auxGroup])
    expect(svc.count).toBe(2)
    expect(svc.getGroup(auxGroup.id)).toBe(auxGroup)
    expect(svc.getGroups(GroupsOrder.GridAppearance)).toEqual([mainGroup, auxGroup])

    // A group added to the main part after the aux part still sorts by its
    // globally monotonic id, not by part order.
    const laterMain = svc.addGroup(mainGroup, GroupDirection.Down)
    expect(svc.groups).toEqual([mainGroup, auxGroup, laterMain])
  })

  it('does not limit global enumeration to the active part', () => {
    const svc = new EditorGroupsService()
    const mainGroup = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })
    aux.activeGroup.openEditor(make('aux'))

    // Root-level rules (Save All, dirty checks, extension enumeration) must see
    // the auxiliary editor even while the main part stays active.
    expect(svc.activePart).toBe(svc.mainPart)
    expect(svc.groups).toContain(mainGroup)
    expect(svc.groups).toContain(aux.activeGroup)
    expect(svc.count).toBe(2)
    expect(svc.getGroups()).toHaveLength(2)
  })

  it('activatePart switches the global active group and fires part/group events', () => {
    const svc = new EditorGroupsService()
    const mainGroup = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })

    const partSpy = vi.fn()
    const groupSpy = vi.fn()
    svc.onDidActivePartChange(partSpy)
    svc.onDidActiveGroupChange(groupSpy)

    svc.activatePart(aux)
    expect(svc.activePart).toBe(aux)
    expect(svc.activeGroup).toBe(aux.activeGroup)
    expect(partSpy).toHaveBeenCalledOnce()
    expect(groupSpy).toHaveBeenCalledWith(aux.activeGroup)
    expect(aux.activeGroup.isActive).toBe(true)
    expect(mainGroup.isActive).toBe(false)

    // activateGroup only retargets opens; it is not a focus move, so the
    // auxiliary part keeps the active editor.
    svc.activateGroup(mainGroup)
    expect(svc.activePart).toBe(aux)
    expect(svc.activeGroup).toBe(aux.activeGroup)
    expect(svc.openTargetGroup).toBe(mainGroup)
    expect(partSpy).toHaveBeenCalledOnce()
    expect(groupSpy).toHaveBeenCalledOnce()

    svc.activatePart(svc.mainPart)
    expect(svc.activePart).toBe(svc.mainPart)
    expect(svc.activeGroup).toBe(mainGroup)
    expect(partSpy).toHaveBeenCalledTimes(2)
    expect(groupSpy).toHaveBeenLastCalledWith(mainGroup)
  })

  it('activating a group in another part retargets opens without moving focus', () => {
    const svc = new EditorGroupsService()
    const aux = svc.createAuxiliaryPart({ activate: false })
    const second = svc.addGroup(aux.activeGroup, GroupDirection.Right)
    expect(svc.activePart).toBe(svc.mainPart)
    expect(svc.openTargetPart).toBe(svc.mainPart)

    svc.activateGroup(second)
    expect(svc.activePart).toBe(svc.mainPart)
    expect(svc.activeGroup).toBe(svc.mainPart.activeGroup)
    expect(svc.openTargetPart).toBe(aux)
    expect(svc.openTargetGroup).toBe(second)
  })

  it('fires onDidActivateOpenTargetGroup for a group switch inside the open target part', () => {
    const svc = new EditorGroupsService()
    const first = svc.mainPart.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    const spy = vi.fn()
    svc.onDidActivateOpenTargetGroup(spy)

    // The part updates its own active group before notifying the host; the event
    // must still fire (regression guard for comparing the new group to itself).
    svc.activateGroup(second)
    expect(spy).toHaveBeenCalledWith(second)
    expect(svc.openTargetGroup).toBe(second)

    // Already the open target: no duplicate event.
    svc.activateGroup(second)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('activatePart records the focus intent for that activation and clears stale ones', () => {
    const svc = new EditorGroupsService()
    const aux = svc.createAuxiliaryPart({ activate: false })
    aux.activeGroup.preserveFocusOnActivation?.()

    // 默认 activatePart 不是窗口激活，必须清掉上一次遗留的保留焦点意图。
    svc.activatePart(aux)
    expect(aux.activeGroup.lastActivationPreservedFocus).toBe(false)

    svc.activatePart(svc.mainPart)
    svc.activatePart(aux, { preserveFocus: true })
    expect(aux.activeGroup.lastActivationPreservedFocus).toBe(true)
  })

  it('findGroup stays inside the source group’s part', () => {
    const svc = new EditorGroupsService()
    const main = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })
    const auxSecond = svc.addGroup(aux.activeGroup, GroupDirection.Right)

    expect(svc.findGroup({ direction: GroupDirection.Right }, main)).toBeUndefined()
    expect(svc.findGroup({ location: GroupLocation.Next }, main)).toBeUndefined()
    expect(svc.findGroup({ location: GroupLocation.Next }, aux.activeGroup)).toBe(auxSecond)
    expect(svc.findGroup({ location: GroupLocation.Previous }, auxSecond)).toBe(aux.activeGroup)
  })

  it('addGroup targets the part that owns the location group', () => {
    const svc = new EditorGroupsService()
    const aux = svc.createAuxiliaryPart({ activate: false })
    const created = svc.addGroup(aux.activeGroup, GroupDirection.Right)

    expect(aux.groups).toContain(created)
    expect(svc.mainPart.groups).not.toContain(created)
    expect(svc.count).toBe(3)

    const byId = svc.addGroup(aux.activeGroup.id, GroupDirection.Down)
    expect(aux.groups).toContain(byId)
  })

  it('resizeGroup uses the owner part’s grid and container measurement', () => {
    const svc = new EditorGroupsService()
    const aux = svc.createAuxiliaryPart({ activate: false })
    const first = aux.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    aux.grid.setContainerSize({ width: 1000, height: 600 })

    const beforeFirst = aux.grid.getViewSize(first)?.width ?? 0
    const beforeSecond = aux.grid.getViewSize(second)?.width ?? 0
    // The main part has a single group, so a `true` here proves the request was
    // routed to the auxiliary part's grid.
    expect(svc.resizeGroup(first, 'width', 50)).toBe(true)
    expect(aux.grid.getViewSize(first)?.width).toBeCloseTo(beforeFirst + 50)
    expect(aux.grid.getViewSize(second)?.width).toBeCloseTo(beforeSecond - 50)
  })

  it('forwards add/remove/move group events from auxiliary parts', () => {
    const svc = new EditorGroupsService()
    const aux = svc.createAuxiliaryPart({ activate: false })
    const addSpy = vi.fn()
    const removeSpy = vi.fn()
    svc.onDidAddGroup(addSpy)
    svc.onDidRemoveGroup(removeSpy)

    const group = svc.addGroup(aux.activeGroup, GroupDirection.Right)
    expect(addSpy).toHaveBeenCalledWith(group)

    svc.removeGroup(group)
    expect(removeSpy).toHaveBeenCalledWith(group)
    expect(svc.count).toBe(2)
  })

  it('createAuxiliaryPart announces its initial group and activates by default', () => {
    const svc = new EditorGroupsService()
    const partSpy = vi.fn()
    const groupSpy = vi.fn()
    svc.onDidAddPart(partSpy)
    svc.onDidAddGroup(groupSpy)

    const aux = svc.createAuxiliaryPart()
    expect(partSpy).toHaveBeenCalledWith(aux)
    expect(groupSpy).toHaveBeenCalledWith(aux.activeGroup)
    expect(svc.activePart).toBe(aux)
  })

  it('keeps a global MRU across parts', () => {
    const svc = new EditorGroupsService()
    const main = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })
    const auxGroup = aux.activeGroup
    const auxSecond = svc.addGroup(auxGroup, GroupDirection.Right)

    svc.activateGroup(auxGroup)
    svc.activateGroup(main)
    expect(svc.getGroups(GroupsOrder.MostRecentlyActive)[0]).toBe(main)
    expect(svc.getGroups(GroupsOrder.MostRecentlyActive)[1]).toBe(auxGroup)

    svc.activateGroup(auxSecond)
    expect(svc.getGroups(GroupsOrder.MostRecentlyActive)[0]).toBe(auxSecond)

    svc.removeGroup(auxSecond)
    expect(svc.getGroups(GroupsOrder.MostRecentlyActive)).not.toContain(auxSecond)
  })

  it('removePart refuses the main part and non-empty aux parts', () => {
    const svc = new EditorGroupsService()
    expect(svc.removePart(svc.mainPart)).toBe(false)

    const aux = svc.createAuxiliaryPart({ activate: false })
    const input = make('keep')
    aux.activeGroup.openEditor(input)
    expect(svc.removePart(aux)).toBe(false)
    expect(svc.parts).toContain(aux)
    expect(aux.activeGroup.contains(input)).toBe(true)
  })

  it('removePart drops an empty aux part and returns focus to main', () => {
    const svc = new EditorGroupsService()
    const aux = svc.createAuxiliaryPart()
    expect(svc.activePart).toBe(aux)
    const partSpy = vi.fn()
    const removePartSpy = vi.fn()
    const removeGroupSpy = vi.fn()
    const openTargetSpy = vi.fn()
    svc.onDidActivePartChange(partSpy)
    svc.onDidRemovePart(removePartSpy)
    svc.onDidRemoveGroup(removeGroupSpy)
    svc.onDidActivateOpenTargetGroup(openTargetSpy)

    expect(svc.removePart(aux)).toBe(true)
    expect(svc.parts).not.toContain(aux)
    expect(svc.activePart).toBe(svc.mainPart)
    // Silent fallback: closing a window must not announce an open-target move.
    expect(svc.openTargetPart).toBe(svc.mainPart)
    expect(openTargetSpy).not.toHaveBeenCalled()
    expect(partSpy).toHaveBeenCalledWith(svc.mainPart)
    expect(removePartSpy).toHaveBeenCalledWith(aux)
    expect(removeGroupSpy).toHaveBeenCalledWith(aux.activeGroup)
    expect(svc.count).toBe(1)
  })

  it('clearAll removes auxiliary parts and resets the main part', () => {
    const svc = new EditorGroupsService()
    svc.mainPart.activeGroup.openEditor(make('a'))
    const aux = svc.createAuxiliaryPart({ activate: false })
    svc.addGroup(aux.activeGroup, GroupDirection.Right)

    svc.clearAll()
    expect(svc.parts).toHaveLength(1)
    expect(svc.parts[0]).toBe(svc.mainPart)
    expect(svc.activePart).toBe(svc.mainPart)
    expect(svc.groups).toHaveLength(1)
    expect(svc.activeGroup.count).toBe(0)
    expect(svc.getGroups(GroupsOrder.MostRecentlyActive)).toEqual([svc.activeGroup])
  })

  it('restores per-part layout via EditorPart.toJSON/restore', () => {
    const provider = EditorRegistry.registerEditorProvider({
      typeId: PersistInput.TYPE_ID,
      componentKey: 'persist',
      deserialize: () => PersistInput.deserialize(),
    })
    try {
      const svc = new EditorGroupsService()
      const aux = svc.createAuxiliaryPart({ activate: false })
      aux.activeGroup.openEditor(new PersistInput())
      svc.addGroup(aux.activeGroup, GroupDirection.Right)
      const state = aux.toJSON()

      const restored = svc.createAuxiliaryPart({ activate: false })
      restored.restore(state)
      expect(restored.groups).toHaveLength(2)
      expect(restored.activeGroup.count).toBe(1)
      expect(restored.activeGroup.activeEditor?.typeId).toBe(PersistInput.TYPE_ID)
    } finally {
      provider.dispose()
    }
  })
})

describe('EditorGroupsService — cross-part editors', () => {
  it('moveEditor uses the explicit source group when the same id is in several groups', () => {
    const svc = new EditorGroupsService()
    const main = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })
    const target = aux.activeGroup

    const inMain = make('same')
    const inAux = make('same')
    main.openEditor(inMain)
    target.openEditor(inAux)
    inAux.setDirty(true)

    // Without the explicit source the global lookup would find `inMain` first
    // and detach the wrong tab.
    svc.moveEditor(inAux, main, target)

    expect(target.count).toBe(0)
    expect(main.count).toBe(1)
    expect(main.activeEditor).toBe(inMain)
    expect(inMain.isDirty).toBe(true)
    expect(inAux.isDisposed).toBe(true)
  })

  it('moveEditor moves an editor across parts without cloning it', () => {
    const svc = new EditorGroupsService()
    const main = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })
    const target = aux.activeGroup
    const input = make('a')
    main.openEditor(input)

    svc.moveEditor(input, target, main)

    expect(main.count).toBe(0)
    expect(target.activeEditor).toBe(input)
    expect(input.isDisposed).toBe(false)
  })

  it('copyEditor keeps the two input instances on independent lifecycles', () => {
    const svc = new EditorGroupsService()
    const main = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })
    const target = aux.activeGroup

    const original = make('a')
    const copy = make('a') // same identity, distinct instance (as cloneEditorInputForSplit yields)
    main.openEditor(original)
    svc.copyEditor(copy, target)

    expect(main.contains(original)).toBe(true)
    expect(target.contains(copy)).toBe(true)

    target.closeEditor(copy)
    expect(copy.isDisposed).toBe(true)
    expect(original.isDisposed).toBe(false)
    expect(main.contains(original)).toBe(true)
  })

  it('moveEditor restores source ownership when the target throws mid-migration', () => {
    const svc = new EditorGroupsService()
    const main = svc.mainPart.activeGroup
    const aux = svc.createAuxiliaryPart({ activate: false })
    const target = aux.activeGroup
    const first = make('first')
    const input = make('rollback')
    main.openEditor(first, { activate: false })
    main.openEditor(input)
    main.stickEditor(first)

    const openSpy = vi.spyOn(target, 'openEditor').mockImplementationOnce(() => {
      throw new Error('migration hook failed')
    })
    expect(() => svc.moveEditor(input, target, main)).toThrow('migration hook failed')
    openSpy.mockRestore()

    // Not ownerless: the same instance is back in the source at its old slot.
    expect(main.findEditor(input)).toBe(input)
    expect(main.indexOf(input)).toBe(1)
    expect(input.isDisposed).toBe(false)
    expect(target.contains(input)).toBe(false)
    expect(target.count).toBe(0)
  })

  it('shares the active editor through IEditorService across parts', () => {
    const svc = new EditorGroupsService()
    const editorService = new EditorService(svc)
    const aux = svc.createAuxiliaryPart({ activate: false })
    const input = make('a')
    aux.activeGroup.openEditor(input)

    let observed: unknown
    const disposable = autorun((r) => {
      observed = editorService.activeEditor.read(r)
    })
    expect(observed).toBeUndefined()

    svc.activatePart(aux)
    expect(observed).toBe(input)
    expect(editorService.openEditors.get()).toEqual([input])
    disposable.dispose()
  })

  it('routes activeGroupForOpen to the open target part', () => {
    const svc = new EditorGroupsService()
    const aux = svc.createAuxiliaryPart({ activate: false })
    expect(svc.activeGroupForOpen).toBe(svc.mainPart.activeGroup)

    // Focus alone does not retarget opens.
    svc.activatePart(aux)
    expect(svc.openTargetPart).toBe(svc.mainPart)
    expect(svc.activeGroupForOpen).toBe(svc.mainPart.activeGroup)

    svc.activatePart(aux, { updateOpenTarget: true })
    expect(svc.openTargetPart).toBe(aux)
    expect(svc.activeGroupForOpen).toBe(aux.activeGroup)
  })
})
