/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for openDocInGroup — plain navigation between built-in guide docs must
 *  reuse the current doc tab (walk the trail in one tab), while `toSide` and a
 *  non-doc active editor open a fresh tab. This is what makes Shift+H / Alt+←
 *  back-navigation land in the same tab instead of piling up new ones.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { EditorInput, URI } from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { DocEditorInput } from '../DocEditorInput.js'
import { openDocInGroup } from '../openDoc.js'

class PlainInput extends EditorInput {
  get typeId(): string {
    return 'plain'
  }
  get resource(): URI {
    return URI.file('D:/plain.txt')
  }
  getName(): string {
    return 'plain'
  }
}

describe('openDocInGroup', () => {
  it('replaces the active doc tab in place (single-tab trail)', () => {
    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const first = new DocEditorInput('index')
    group.openEditor(first, { activate: true, pinned: true })
    expect(group.editors).toHaveLength(1)

    const second = new DocEditorInput('getting-started/interface-tour')
    openDocInGroup(group, second, false)

    // The old doc is closed and the new one takes its slot — no extra tab.
    expect(group.editors).toHaveLength(1)
    expect(group.activeEditor).toBe(second)
  })

  it('opens an additional tab with toSide', () => {
    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const first = new DocEditorInput('index')
    group.openEditor(first, { activate: true, pinned: true })

    const second = new DocEditorInput('getting-started/interface-tour')
    openDocInGroup(group, second, true)

    expect(group.editors).toHaveLength(2)
  })

  it('does not close a non-doc active editor', () => {
    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const plain = new PlainInput()
    group.openEditor(plain, { activate: true, pinned: true })

    const doc = new DocEditorInput('index')
    openDocInGroup(group, doc, false)

    // The plain editor stays; the doc opens alongside it.
    expect(group.editors).toHaveLength(2)
    expect(group.activeEditor).toBe(doc)
  })

  it('reuses the tab when the target doc is already the active one', () => {
    const svc = new EditorGroupsService()
    const group = svc.activeGroup
    const doc = new DocEditorInput('index')
    group.openEditor(doc, { activate: true, pinned: true })

    // Same id → dedup path, no close of self.
    openDocInGroup(group, new DocEditorInput('index'), false)
    expect(group.editors).toHaveLength(1)
  })
})
