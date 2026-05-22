/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for RecentEditorsService — MRU cross-group tracker used by Ctrl+Tab.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorInput, EditorRegistry, GroupDirection, URI } from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { RecentEditorsService } from '../RecentEditorsService.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class StableInput extends EditorInput {
  static readonly TYPE_ID = 'stable.recent.test'

  static deserialize(data: unknown): StableInput {
    return new StableInput((data as { uri: string }).uri)
  }

  constructor(private readonly _uri: string) {
    super()
  }
  override get typeId(): string {
    return StableInput.TYPE_ID
  }
  override get resource(): URI {
    return URI.parse(this._uri)
  }
  override getName(): string {
    return this._uri
  }
  override serialize(): { uri: string } {
    return { uri: this._uri }
  }
}

function makeInput(name: string): StableInput {
  return new StableInput(`test:///${name}`)
}

let cleanupRegistry: (() => void) | undefined

beforeEach(() => {
  const d = EditorRegistry.registerEditorProvider({
    typeId: StableInput.TYPE_ID,
    componentKey: 'stable',
    deserialize: (data) => StableInput.deserialize(data),
  })
  cleanupRegistry = () => d.dispose()
})

afterEach(() => {
  cleanupRegistry?.()
  cleanupRegistry = undefined
})

// ---------------------------------------------------------------------------
// Basic MRU tracking
// ---------------------------------------------------------------------------

describe('RecentEditorsService — basic MRU tracking', () => {
  it('returns empty list when no editors are open', () => {
    const groups = new EditorGroupsService()
    const svc = new RecentEditorsService(groups)
    expect(svc.getRecentEditors()).toHaveLength(0)
    svc.dispose()
    groups.dispose()
  })

  it('lists the active editor after it is opened', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    groups.activeGroup.openEditor(a)
    const svc = new RecentEditorsService(groups)
    const recent = svc.getRecentEditors()
    expect(recent).toHaveLength(1)
    expect(recent[0]!.editor.id).toBe(a.id)
    svc.dispose()
    groups.dispose()
  })

  it('most-recently-activated editor appears first', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const b = makeInput('b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b) // b is now active
    const svc = new RecentEditorsService(groups)

    // Activate a — it should bubble to the head
    groups.activeGroup.setActive(a)
    const recent = svc.getRecentEditors()
    expect(recent[0]!.editor.id).toBe(a.id)
    expect(recent[1]!.editor.id).toBe(b.id)
    svc.dispose()
    groups.dispose()
  })

  it('closed editor is removed from getRecentEditors', () => {
    const groups = new EditorGroupsService()
    const a = makeInput('a')
    const b = makeInput('b')
    groups.activeGroup.openEditor(a)
    groups.activeGroup.openEditor(b)
    const svc = new RecentEditorsService(groups)
    groups.activeGroup.closeEditor(b)
    const ids = svc.getRecentEditors().map((r) => r.editor.id)
    expect(ids).not.toContain(b.id)
    svc.dispose()
    groups.dispose()
  })
})

// ---------------------------------------------------------------------------
// Restore scenario — simulates what happens after editor restart
// ---------------------------------------------------------------------------

describe('RecentEditorsService — after workspace restore', () => {
  it('includes background (non-active) editors from the same group', () => {
    // Build source state: one group with active + two background editors.
    const src = new EditorGroupsService()
    const active = makeInput('active')
    const bg1 = makeInput('bg1')
    const bg2 = makeInput('bg2')
    src.activeGroup.openEditor(active)
    src.activeGroup.openEditor(bg1, { activate: false })
    src.activeGroup.openEditor(bg2, { activate: false })
    expect(src.activeGroup.activeEditor?.id).toBe(active.id)
    const state = src.toJSON()
    src.dispose()

    // Simulate restart: RecentEditorsService created BEFORE restore,
    // matching the actual boot order in main.tsx.
    const dst = new EditorGroupsService()
    const svc = new RecentEditorsService(dst) // created on empty groups
    dst.restore(state)

    const recent = svc.getRecentEditors()
    const ids = recent.map((r) => r.editor.id)

    // All three editors must appear in the list.
    expect(recent).toHaveLength(3)
    expect(ids).toContain(active.id)
    expect(ids).toContain(bg1.id)
    expect(ids).toContain(bg2.id)

    svc.dispose()
    dst.dispose()
  })

  it('active editor comes first after restore', () => {
    const src = new EditorGroupsService()
    const bg = makeInput('bg')
    const active = makeInput('active')
    src.activeGroup.openEditor(bg, { activate: false })
    src.activeGroup.openEditor(active) // opened and activated last
    src.activeGroup.setActive(active)
    const state = src.toJSON()
    src.dispose()

    const dst = new EditorGroupsService()
    const svc = new RecentEditorsService(dst)
    dst.restore(state)

    const recent = svc.getRecentEditors()
    expect(recent).toHaveLength(2)
    expect(recent[0]!.editor.id).toBe(active.id)

    svc.dispose()
    dst.dispose()
  })

  it('includes background editors from multiple restored groups', () => {
    const src = new EditorGroupsService()

    const g1active = makeInput('g1-active')
    const g1bg = makeInput('g1-background')
    src.activeGroup.openEditor(g1active)
    src.activeGroup.openEditor(g1bg, { activate: false })

    const g2 = src.addGroup(src.activeGroup, GroupDirection.Right)
    const g2active = makeInput('g2-active')
    const g2bg = makeInput('g2-background')
    g2.openEditor(g2active)
    g2.openEditor(g2bg, { activate: false })

    const state = src.toJSON()
    src.dispose()

    const dst = new EditorGroupsService()
    const svc = new RecentEditorsService(dst)
    dst.restore(state)

    const recent = svc.getRecentEditors()
    const ids = recent.map((r) => r.editor.id)

    expect(recent).toHaveLength(4)
    expect(ids).toContain(g1active.id)
    expect(ids).toContain(g1bg.id)
    expect(ids).toContain(g2active.id)
    expect(ids).toContain(g2bg.id)

    svc.dispose()
    dst.dispose()
  })

  it('includes background editors when service is created after restore', () => {
    // Control: service created AFTER restore must also return all editors.
    const src = new EditorGroupsService()
    const active = makeInput('active')
    const bg = makeInput('bg')
    src.activeGroup.openEditor(active)
    src.activeGroup.openEditor(bg, { activate: false })
    const state = src.toJSON()
    src.dispose()

    const dst = new EditorGroupsService()
    dst.restore(state) // restore first
    const svc = new RecentEditorsService(dst) // service created after restore

    const recent = svc.getRecentEditors()
    expect(recent).toHaveLength(2)
    const ids = recent.map((r) => r.editor.id)
    expect(ids).toContain(active.id)
    expect(ids).toContain(bg.id)

    svc.dispose()
    dst.dispose()
  })
})
