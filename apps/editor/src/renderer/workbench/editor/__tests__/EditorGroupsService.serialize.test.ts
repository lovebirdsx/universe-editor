/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for EditorGroupsService.toJSON() / restore().
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorInput, EditorRegistry, GroupDirection, URI } from '@universe-editor/platform'
import { EditorGroupsService, type ISerializedEditorGroupsState } from '../EditorGroupsService.js'

class FakeEditorInput extends EditorInput {
  static readonly TYPE_ID = 'fake.test.editor'
  static deserialize(): FakeEditorInput {
    return new FakeEditorInput()
  }
  override get typeId(): string {
    return FakeEditorInput.TYPE_ID
  }
  override get resource(): URI {
    return URI.from({ scheme: 'fake', path: '/' + Math.random().toString(36).slice(2) })
  }
  override getName(): string {
    return 'Fake'
  }
}

class OtherEditorInput extends EditorInput {
  static readonly TYPE_ID = 'other.test.editor'
  static deserialize(): OtherEditorInput {
    return new OtherEditorInput()
  }
  override get typeId(): string {
    return OtherEditorInput.TYPE_ID
  }
  override get resource(): URI {
    return URI.from({ scheme: 'other', path: '/x' })
  }
  override getName(): string {
    return 'Other'
  }
}

describe('EditorGroupsService serialization', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    const d1 = EditorRegistry.registerEditorProvider({
      typeId: FakeEditorInput.TYPE_ID,
      componentKey: 'fake',
      deserialize: () => FakeEditorInput.deserialize(),
    })
    const d2 = EditorRegistry.registerEditorProvider({
      typeId: OtherEditorInput.TYPE_ID,
      componentKey: 'other',
      deserialize: () => OtherEditorInput.deserialize(),
    })
    dispose = () => {
      d1.dispose()
      d2.dispose()
    }
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('toJSON serialises a single group with a single editor', () => {
    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(new FakeEditorInput())
    const json = svc.toJSON()
    // The Grid always wraps in a branch root; a single group is its only leaf.
    expect(json.grid.root.type).toBe('branch')
    if (json.grid.root.type === 'branch') {
      expect(json.grid.root.children).toHaveLength(1)
      const leaf = json.grid.root.children?.[0]
      expect(leaf?.type).toBe('leaf')
      if (leaf?.type === 'leaf' && leaf.data) {
        expect(leaf.data.editors).toHaveLength(1)
        expect(leaf.data.editors[0]?.typeId).toBe(FakeEditorInput.TYPE_ID)
      }
    }
    svc.dispose()
  })

  it('toJSON captures activeIndex for multi-editor groups', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditorInput()
    const b = new OtherEditorInput()
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    svc.activeGroup.setActive(a)
    const json = svc.toJSON()
    if (json.grid.root.type === 'branch') {
      const leaf = json.grid.root.children?.[0]
      if (leaf?.type === 'leaf' && leaf.data) {
        expect(leaf.data.editors).toHaveLength(2)
        expect(leaf.data.activeIndex).toBe(0)
      }
    }
    svc.dispose()
  })

  it('toJSON encodes a horizontal split as a branch with two leaves', () => {
    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(new FakeEditorInput())
    const second = svc.addGroup(svc.activeGroup, GroupDirection.Right)
    second.openEditor(new OtherEditorInput())
    const json = svc.toJSON()
    expect(json.grid.root.type).toBe('branch')
    if (json.grid.root.type === 'branch') {
      expect(json.grid.root.children).toHaveLength(2)
    }
    svc.dispose()
  })

  it('restore rebuilds groups and editors from serialized state', () => {
    const src = new EditorGroupsService()
    src.activeGroup.openEditor(new FakeEditorInput())
    const second = src.addGroup(src.activeGroup, GroupDirection.Right)
    second.openEditor(new OtherEditorInput())
    const json = src.toJSON()
    src.dispose()

    const dst = new EditorGroupsService()
    dst.restore(json)
    expect(dst.groups).toHaveLength(2)
    expect(dst.groups[0]?.count).toBe(1)
    expect(dst.groups[1]?.count).toBe(1)
    expect(dst.groups[0]?.activeEditor?.typeId).toBe(FakeEditorInput.TYPE_ID)
    expect(dst.groups[1]?.activeEditor?.typeId).toBe(OtherEditorInput.TYPE_ID)
    dst.dispose()
  })

  it('restore skips editors with unknown typeId', () => {
    const state: ISerializedEditorGroupsState = {
      grid: {
        root: {
          type: 'branch',
          size: 1,
          children: [
            {
              type: 'leaf',
              size: 1,
              data: {
                editors: [
                  { typeId: 'unknown.type.never.registered', data: null },
                  { typeId: FakeEditorInput.TYPE_ID, data: null },
                ],
                activeIndex: 1,
              },
            },
          ],
        },
        orientation: 0, // Horizontal
        width: 800,
        height: 600,
      },
      activeGroupId: 0,
    }
    const dst = new EditorGroupsService()
    dst.restore(state)
    expect(dst.groups).toHaveLength(1)
    expect(dst.groups[0]?.count).toBe(1)
    expect(dst.groups[0]?.activeEditor?.typeId).toBe(FakeEditorInput.TYPE_ID)
    dst.dispose()
  })

  it('toJSON → restore → toJSON is shape-stable', () => {
    const src = new EditorGroupsService()
    src.activeGroup.openEditor(new FakeEditorInput())
    src.activeGroup.openEditor(new OtherEditorInput())
    const second = src.addGroup(src.activeGroup, GroupDirection.Down)
    second.openEditor(new FakeEditorInput())
    const json1 = src.toJSON()
    src.dispose()

    const dst = new EditorGroupsService()
    dst.restore(json1)
    const json2 = dst.toJSON()
    expect(json2.grid.root.type).toBe(json1.grid.root.type)
    if (json1.grid.root.type === 'branch' && json2.grid.root.type === 'branch') {
      expect(json2.grid.root.children?.length ?? 0).toBe(json1.grid.root.children?.length ?? 0)
    }
    dst.dispose()
  })
})
