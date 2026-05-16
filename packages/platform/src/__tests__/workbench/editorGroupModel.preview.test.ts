/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupModel — preview-slot semantics (主题 11 WP1).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { EditorGroupModel, IEditorGroupModelChangeEvent } from '../../workbench/editorGroupModel.js'
import { EditorInput } from '../../workbench/editorService.js'
import { URI } from '../../base/uri.js'

class TestInput extends EditorInput {
  disposed = false
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
  override dispose(): void {
    this.disposed = true
    super.dispose()
  }
}

function make(name: string): TestInput {
  return new TestInput(URI.file(`D:/${name}.txt`), name)
}

describe('EditorGroupModel — preview slot', () => {
  it('opens an editor into the preview slot when pinned:false and no existing preview', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a, { pinned: false })
    expect(model.count).toBe(1)
    expect(model.previewEditor).toBe(a)
    expect(model.isPinned(a)).toBe(false)
  })

  it('replaces the preview in-place when a second pinned:false editor is opened', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    const events: IEditorGroupModelChangeEvent[] = []
    model.openEditor(a, { pinned: false })
    model.onDidChangeModel((e) => events.push(e))
    model.openEditor(b, { pinned: false })
    expect(model.count).toBe(1)
    expect(model.editors[0]).toBe(b)
    expect(model.previewEditor).toBe(b)
    expect(a.disposed).toBe(true)
    expect(events.some((e) => e.kind === 'previewReplace' && e.editor === b)).toBe(true)
  })

  it('promotes the existing preview to pinned when re-opened with pinned:true', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const events: IEditorGroupModelChangeEvent[] = []
    model.openEditor(a, { pinned: false })
    model.onDidChangeModel((e) => events.push(e))
    model.openEditor(a, { pinned: true })
    expect(model.previewEditor).toBeUndefined()
    expect(model.isPinned(a)).toBe(true)
    expect(events.some((e) => e.kind === 'pin' && e.editor === a)).toBe(true)
  })

  it('pinEditor on an already-pinned editor is a no-op', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const events: IEditorGroupModelChangeEvent[] = []
    model.openEditor(a)
    model.onDidChangeModel((e) => events.push(e))
    model.pinEditor(a)
    expect(events.filter((e) => e.kind === 'pin')).toHaveLength(0)
  })

  it('closing the preview editor clears the slot', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a, { pinned: false })
    expect(model.previewEditor).toBe(a)
    model.closeEditor(a)
    expect(model.previewEditor).toBeUndefined()
  })

  it('isPinned returns true for editors not in the preview slot', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b, { pinned: false })
    expect(model.isPinned(a)).toBe(true)
    expect(model.isPinned(b)).toBe(false)
    const c = make('c')
    expect(model.isPinned(c)).toBe(false)
  })
})
