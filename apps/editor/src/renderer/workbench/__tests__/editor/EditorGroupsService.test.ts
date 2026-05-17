/*---------------------------------------------------------------------------------------------
 *  Tests for the renderer EditorGroupsService.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { EditorInput, GroupDirection, GroupLocation, URI } from '@universe-editor/platform'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'

class TestInput extends EditorInput {
  constructor(
    private readonly _resource: URI,
    private readonly _name: string,
  ) {
    super()
  }
  get typeId(): string {
    return 'test'
  }
  get resource(): URI {
    return this._resource
  }
  getName(): string {
    return this._name
  }
}

function make(name: string): TestInput {
  return new TestInput(URI.file(`D:/${name}.txt`), name)
}

describe('EditorGroupsService', () => {
  it('starts with one group that is active', () => {
    const svc = new EditorGroupsService()
    expect(svc.count).toBe(1)
    expect(svc.activeGroup).toBeDefined()
    expect(svc.activeGroup.isActive).toBe(true)
    expect(svc.activeGroup.index).toBe(0)
  })

  it('addGroup creates a new group and fires onDidAddGroup', () => {
    const svc = new EditorGroupsService()
    const spy = vi.fn()
    svc.onDidAddGroup(spy)
    const newGroup = svc.addGroup(svc.activeGroup, GroupDirection.Right)
    expect(svc.count).toBe(2)
    expect(spy).toHaveBeenCalledOnce()
    expect(newGroup).toBeDefined()
    expect(svc.groups).toContain(newGroup)
  })

  it('activateGroup updates activeGroup and fires onDidActiveGroupChange', () => {
    const svc = new EditorGroupsService()
    const second = svc.addGroup(svc.activeGroup, GroupDirection.Right)
    const spy = vi.fn()
    svc.onDidActiveGroupChange(spy)
    svc.activateGroup(second)
    expect(svc.activeGroup).toBe(second)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('activateGroup on already-active group is a no-op', () => {
    const svc = new EditorGroupsService()
    const spy = vi.fn()
    svc.onDidActiveGroupChange(spy)
    svc.activateGroup(svc.activeGroup)
    expect(spy).not.toHaveBeenCalled()
  })

  it('removeGroup on the only group is a no-op', () => {
    const svc = new EditorGroupsService()
    const onlyGroup = svc.activeGroup
    svc.removeGroup(onlyGroup)
    expect(svc.count).toBe(1)
    expect(svc.activeGroup).toBe(onlyGroup)
  })

  it('removeGroup fires onDidRemoveGroup and falls back to another group', () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    svc.activateGroup(second)
    const spy = vi.fn()
    svc.onDidRemoveGroup(spy)
    svc.removeGroup(second)
    expect(svc.count).toBe(1)
    expect(svc.activeGroup).toBe(first)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('getGroup by id resolves the group', () => {
    const svc = new EditorGroupsService()
    const id = svc.activeGroup.id
    expect(svc.getGroup(id)).toBe(svc.activeGroup)
  })

  it('moveEditor relocates an editor between groups', () => {
    const svc = new EditorGroupsService()
    const second = svc.addGroup(svc.activeGroup, GroupDirection.Right)
    const a = make('a')
    svc.activeGroup.openEditor(a)
    expect(svc.activeGroup.editors.length).toBe(1)
    expect(second.editors.length).toBe(0)
    svc.moveEditor(a, second)
    expect(svc.activeGroup.editors.length).toBe(0)
    expect(second.editors.length).toBe(1)
  })

  it('copyEditor duplicates the editor into the target group', () => {
    const svc = new EditorGroupsService()
    const second = svc.addGroup(svc.activeGroup, GroupDirection.Right)
    const a = make('a')
    svc.activeGroup.openEditor(a)
    svc.copyEditor(a, second)
    expect(svc.activeGroup.contains(a)).toBe(true)
    expect(second.contains(a)).toBe(true)
  })

  it('findGroup({location: Next}) returns the next group', () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    expect(svc.findGroup({ location: GroupLocation.Next }, first)).toBe(second)
    expect(svc.findGroup({ location: GroupLocation.Next }, second)).toBeUndefined()
  })

  it('findGroup({location: Previous}) wraps when wrap=true', () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    expect(svc.findGroup({ location: GroupLocation.Previous }, first, true)).toBe(second)
    expect(svc.findGroup({ location: GroupLocation.Previous }, first, false)).toBeUndefined()
  })

  it('findGroup({location: First/Last})', () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    expect(svc.findGroup({ location: GroupLocation.First })).toBe(first)
    expect(svc.findGroup({ location: GroupLocation.Last })).toBe(second)
  })

  it('activateGroup bumps the group to the front of MRU', () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    const third = svc.addGroup(second, GroupDirection.Right)
    svc.activateGroup(first)
    svc.activateGroup(third)
    svc.activateGroup(second)
    // Remove the active group; should fall back to the previous MRU entry (third).
    svc.removeGroup(second)
    expect(svc.activeGroup).toBe(third)
  })

  it('activeGroup.openEditor delegates to the underlying model', () => {
    const svc = new EditorGroupsService()
    const a = make('a')
    svc.activeGroup.openEditor(a)
    expect(svc.activeGroup.activeEditor).toBe(a)
    expect(svc.activeGroup.count).toBe(1)
  })
})

describe('EditorGroupsService — auto-close empty group', () => {
  it('closing the last editor in a secondary group removes it automatically', async () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    const a = make('a')
    second.openEditor(a)
    svc.activateGroup(second)
    second.closeEditor(a)
    await Promise.resolve()
    expect(svc.count).toBe(1)
    expect(svc.groups).toContain(first)
    expect(svc.groups).not.toContain(second)
  })

  it('closing the last editor in the only group does NOT remove it', async () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const a = make('a')
    first.openEditor(a)
    first.closeEditor(a)
    await Promise.resolve()
    expect(svc.count).toBe(1)
  })

  it('auto-close fires onDidRemoveGroup', async () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    const a = make('a')
    second.openEditor(a)
    const spy = vi.fn()
    svc.onDidRemoveGroup(spy)
    second.closeEditor(a)
    await Promise.resolve()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('auto-close transfers focus to another group', async () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    const a = make('a')
    second.openEditor(a)
    svc.activateGroup(second)
    second.closeEditor(a)
    await Promise.resolve()
    expect(svc.activeGroup).toBe(first)
  })

  it('group with multiple editors is not removed when only one editor is closed', async () => {
    const svc = new EditorGroupsService()
    const first = svc.activeGroup
    const second = svc.addGroup(first, GroupDirection.Right)
    const a = make('a')
    const b = make('b')
    second.openEditor(a)
    second.openEditor(b)
    second.closeEditor(a)
    await Promise.resolve()
    expect(svc.count).toBe(2)
  })
})
