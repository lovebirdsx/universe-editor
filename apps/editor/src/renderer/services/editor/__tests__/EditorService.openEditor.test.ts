import { describe, it, expect, vi } from 'vitest'
import { autorun, GroupDirection } from '@universe-editor/platform'
import { EditorService } from '../EditorService.js'
import { EditorGroupsService } from '../EditorGroupsService.js'

function makeInput(id: string) {
  return { id, type: 'text', label: id, isDirty: false }
}

describe('EditorService', () => {
  it('openEditor appends and activates', () => {
    const svc = new EditorService()
    svc.openEditor(makeInput('a'))
    expect(svc.openEditors.get().map((e) => e.id)).toEqual(['a'])
    expect(svc.activeEditorId.get()).toBe('a')
    expect(svc.activeEditor.get()?.id).toBe('a')
  })

  it('openEditor on existing input only switches active, does not duplicate', () => {
    const svc = new EditorService()
    svc.openEditor(makeInput('a'))
    svc.openEditor(makeInput('b'))
    svc.openEditor(makeInput('a'))
    expect(svc.openEditors.get().map((e) => e.id)).toEqual(['a', 'b'])
    expect(svc.activeEditorId.get()).toBe('a')
  })

  it('openEditor fires exactly one reaction per call (transaction batching)', () => {
    const svc = new EditorService()
    const spy = vi.fn()
    const d = autorun((r) => {
      svc.openEditors.read(r)
      svc.activeEditorId.read(r)
      spy()
    })
    spy.mockClear()

    svc.openEditor(makeInput('a'))
    expect(spy).toHaveBeenCalledTimes(1)

    svc.openEditor(makeInput('b'))
    expect(spy).toHaveBeenCalledTimes(2)
    d.dispose()
  })

  it('closeEditor on active editor picks predecessor', () => {
    const svc = new EditorService()
    svc.openEditor(makeInput('a'))
    svc.openEditor(makeInput('b'))
    svc.openEditor(makeInput('c'))
    svc.closeEditor('c')
    expect(svc.activeEditorId.get()).toBe('b')
    svc.closeEditor('a')
    expect(svc.activeEditorId.get()).toBe('b')
  })

  it('closeAllEditors clears state in single reaction', () => {
    const svc = new EditorService()
    svc.openEditor(makeInput('a'))
    svc.openEditor(makeInput('b'))

    const spy = vi.fn()
    const d = autorun((r) => {
      svc.openEditors.read(r)
      svc.activeEditorId.read(r)
      spy()
    })
    spy.mockClear()

    svc.closeAllEditors()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(svc.openEditors.get()).toEqual([])
    expect(svc.activeEditorId.get()).toBeUndefined()
    d.dispose()
  })

  it('closeAllEditors on empty service is a no-op', () => {
    const svc = new EditorService()
    const spy = vi.fn()
    const d = autorun((r) => {
      svc.openEditors.read(r)
      spy()
    })
    spy.mockClear()
    svc.closeAllEditors()
    expect(spy).toHaveBeenCalledTimes(0)
    d.dispose()
  })

  it('activeEditor derived reflects activeEditorId', () => {
    const svc = new EditorService()
    expect(svc.activeEditor.get()).toBeUndefined()
    svc.openEditor(makeInput('a'))
    svc.openEditor(makeInput('b'))
    expect(svc.activeEditor.get()?.id).toBe('b')
  })

  it('openEditor routed to a non-active group activates it by default', () => {
    const groups = new EditorGroupsService()
    const svc = new EditorService(groups)
    const first = groups.activeGroup
    const second = groups.addGroup(first, GroupDirection.Right)
    groups.activateGroup(first)
    first.lock(true)

    svc.openEditor(makeInput('a'))
    expect(second.editors.map((e) => e.id)).toEqual(['a'])
    expect(groups.activeGroup).toBe(second)
  })

  it('openEditor with preserveFocus routed to a non-active group does not activate it', () => {
    const groups = new EditorGroupsService()
    const svc = new EditorService(groups)
    const first = groups.activeGroup
    const second = groups.addGroup(first, GroupDirection.Right)
    groups.activateGroup(first)
    first.lock(true)

    svc.openEditor(makeInput('a'), { pinned: false, preserveFocus: true })
    expect(second.editors.map((e) => e.id)).toEqual(['a'])
    expect(groups.activeGroup).toBe(first)
  })
})
