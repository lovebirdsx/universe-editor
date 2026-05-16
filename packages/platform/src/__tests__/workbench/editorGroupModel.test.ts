/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupModel — single-group editor list + active + MRU.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { EditorGroupModel, IEditorGroupModelChangeEvent } from '../../workbench/editorGroupModel.js'
import { EditorInput } from '../../workbench/editorService.js'
import { URI } from '../../base/uri.js'

class TestInput extends EditorInput {
  constructor(
    private readonly _resource: URI | undefined,
    private readonly _name: string,
    private readonly _typeId = 'test',
  ) {
    super()
  }
  get typeId(): string {
    return this._typeId
  }
  get resource(): URI | undefined {
    return this._resource
  }
  getName(): string {
    return this._name
  }
}

function make(name: string): TestInput {
  return new TestInput(URI.file(`D:/${name}.txt`), name)
}

describe('EditorGroupModel — open', () => {
  it('appends editor and activates it', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    expect(model.count).toBe(1)
    expect(model.editors[0]).toBe(a)
    expect(model.activeEditor).toBe(a)
  })

  it('open existing editor only switches active without inserting duplicate', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b)
    expect(model.activeEditor).toBe(b)
    model.openEditor(a)
    expect(model.count).toBe(2)
    expect(model.activeEditor).toBe(a)
  })

  it('open with activate:false keeps the previous active', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b, { activate: false })
    expect(model.activeEditor).toBe(a)
    expect(model.count).toBe(2)
  })

  it('open into empty group with activate:false still activates first editor', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a, { activate: false })
    expect(model.activeEditor).toBe(a)
  })

  it('open with index:0 inserts at front', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b, { index: 0 })
    expect(model.editors[0]).toBe(b)
    expect(model.editors[1]).toBe(a)
  })

  it('fires open event with newIndex', () => {
    const model = new EditorGroupModel()
    const events: IEditorGroupModelChangeEvent[] = []
    model.onDidChangeModel((e) => events.push(e))
    const a = make('a')
    model.openEditor(a)
    const openEvt = events.find((e) => e.kind === 'open')
    expect(openEvt).toBeDefined()
    expect(openEvt!.editor).toBe(a)
    expect(openEvt!.newIndex).toBe(0)
  })
})

describe('EditorGroupModel — close', () => {
  it('close active falls back to MRU predecessor', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    const c = make('c')
    model.openEditor(a)
    model.openEditor(b)
    model.openEditor(c)
    // MRU now: [c, b, a]
    model.closeEditor(c)
    // Active should be b (next in MRU)
    expect(model.activeEditor).toBe(b)
  })

  it('close non-active does not change active', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b)
    expect(model.activeEditor).toBe(b)
    model.closeEditor(a)
    expect(model.activeEditor).toBe(b)
    expect(model.count).toBe(1)
  })

  it('close last editor clears active', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    model.closeEditor(a)
    expect(model.activeEditor).toBeUndefined()
    expect(model.count).toBe(0)
  })

  it('close unknown editor returns false', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    expect(model.closeEditor(b)).toBe(false)
  })

  it('closeAllEditors empties group and fires single active=undefined event', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b)
    const activeSpy = vi.fn()
    model.onDidActiveEditorChange(activeSpy)
    model.closeAllEditors()
    expect(model.count).toBe(0)
    expect(model.activeEditor).toBeUndefined()
    expect(activeSpy).toHaveBeenCalledOnce()
  })

  it('closeAllEditors on empty group is a no-op', () => {
    const model = new EditorGroupModel()
    const activeSpy = vi.fn()
    model.onDidActiveEditorChange(activeSpy)
    model.closeAllEditors()
    expect(activeSpy).not.toHaveBeenCalled()
  })
})

describe('EditorGroupModel — move', () => {
  it('moveEditor fires move event with old and newIndex', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    const c = make('c')
    model.openEditor(a)
    model.openEditor(b)
    model.openEditor(c)
    const events: IEditorGroupModelChangeEvent[] = []
    model.onDidChangeModel((e) => events.push(e))
    model.moveEditor(a, 2)
    const moveEvt = events.find((e) => e.kind === 'move')
    expect(moveEvt).toBeDefined()
    expect(moveEvt!.oldIndex).toBe(0)
    expect(moveEvt!.newIndex).toBe(2)
    expect(model.editors[2]).toBe(a)
  })

  it('moveEditor to same index is a no-op', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    const spy = vi.fn()
    model.onDidChangeModel(spy)
    model.moveEditor(a, 0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('moveEditor clamps target index to valid range', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b)
    model.moveEditor(a, 99)
    expect(model.editors[1]).toBe(a)
  })
})

describe('EditorGroupModel — setActive', () => {
  it('setActive fires onDidActiveEditorChange', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b)
    const spy = vi.fn()
    model.onDidActiveEditorChange(spy)
    model.setActive(a)
    expect(spy).toHaveBeenCalledOnce()
    expect(model.activeEditor).toBe(a)
  })

  it('setActive to already-active editor is a no-op', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    const spy = vi.fn()
    model.onDidActiveEditorChange(spy)
    model.setActive(a)
    expect(spy).not.toHaveBeenCalled()
  })

  it('setActive on unknown editor is a no-op', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.setActive(b)
    expect(model.activeEditor).toBe(a)
  })
})

describe('EditorGroupModel — query helpers', () => {
  it('indexOf returns -1 for unknown editor', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    expect(model.indexOf(a)).toBe(-1)
  })

  it('contains uses matches() identity', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const aDup = new TestInput(URI.file('D:/a.txt'), 'a-renamed')
    model.openEditor(a)
    expect(model.contains(aDup)).toBe(true)
  })

  it('isFirst / isLast on empty model returns false', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    expect(model.isFirst(a)).toBe(false)
    expect(model.isLast(a)).toBe(false)
  })

  it('isFirst / isLast correctly identify boundaries', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    const c = make('c')
    model.openEditor(a)
    model.openEditor(b)
    model.openEditor(c)
    expect(model.isFirst(a)).toBe(true)
    expect(model.isFirst(c)).toBe(false)
    expect(model.isLast(c)).toBe(true)
    expect(model.isLast(a)).toBe(false)
  })

  it('getEditorByIndex returns editor or undefined', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    expect(model.getEditorByIndex(0)).toBe(a)
    expect(model.getEditorByIndex(5)).toBeUndefined()
  })
})

describe('EditorGroupModel — group id', () => {
  it('each instance gets a unique increasing id', () => {
    const a = new EditorGroupModel()
    const b = new EditorGroupModel()
    expect(b.id).toBeGreaterThan(a.id)
  })
})
