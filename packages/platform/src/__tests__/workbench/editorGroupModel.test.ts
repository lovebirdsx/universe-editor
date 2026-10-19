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

  it('disposes a duplicate-identity orphan instead of leaking it', () => {
    // Reopen Closed Editor deserializes a fresh input for a tab that may still
    // be open: the existing entry wins and the freshly-built duplicate is never
    // adopted. It must be disposed, not left dangling (leak).
    const model = new EditorGroupModel()
    const a = make('a')
    const dup = make('a') // same resource → same id, distinct instance
    model.openEditor(a)
    model.openEditor(dup)
    expect(model.count).toBe(1)
    expect(model.editors[0]).toBe(a)
    expect(dup.isDisposed).toBe(true)
    expect(a.isDisposed).toBe(false)
  })

  it('lets the existing input absorb newer state via updateFrom before disposing the orphan', () => {
    const model = new EditorGroupModel()
    let absorbed: EditorInput | undefined
    class UpdatableInput extends TestInput {
      override updateFrom(other: EditorInput): void {
        absorbed = other
      }
    }
    const a = new UpdatableInput(URI.file('D:/u.txt'), 'a')
    const dup = new UpdatableInput(URI.file('D:/u.txt'), 'a')
    model.openEditor(a)
    model.openEditor(dup)
    expect(absorbed).toBe(dup)
    expect(dup.isDisposed).toBe(true)
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

describe('EditorGroupModel — replaceEditor', () => {
  it('swaps in place, preserves active slot and disposes the old input', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b)
    const moved = make('a-renamed')

    const events: IEditorGroupModelChangeEvent[] = []
    model.onDidChangeModel((e) => events.push(e))
    const activation = model.activationId

    expect(model.replaceEditor(a, moved)).toBe(true)
    expect(model.editors).toEqual([moved, b])
    expect(model.activeEditor).toBe(b)
    expect(model.activationId).toBe(activation)
    expect(a.isDisposed).toBe(true)
    expect(moved.isDisposed).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'replace',
      editor: moved,
      oldIndex: 0,
      newIndex: 0,
      replacedEditor: a,
    })
  })

  it('keeps the active pointer on the replacement without bumping activationId', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    const moved = make('a-renamed')
    const onActive = vi.fn()
    model.onDidActiveEditorChange(onActive)
    const activation = model.activationId

    model.replaceEditor(a, moved)

    expect(model.activeEditor).toBe(moved)
    expect(model.activationId).toBe(activation)
    expect(model.lastActivationPreservedFocus).toBe(true)
    expect(onActive).toHaveBeenCalledTimes(1)
  })

  it('preserves preview, sticky region and MRU order', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    const c = make('c')
    const d = make('d')
    model.openEditor(a, { sticky: true })
    model.openEditor(b, { pinned: false })
    model.openEditor(c)
    model.openEditor(d) // d active; MRU d, c, b, a
    const moved = make('b-renamed')

    model.replaceEditor(b, moved)

    expect(model.previewEditor).toBe(moved)
    expect(model.isSticky(a)).toBe(true)
    expect(model.isPinned(moved)).toBe(false)
    // Activate a to inspect MRU-derived fallbacks: after replacing b in place,
    // closing moved should still leave c/d ahead of a in MRU.
    model.setActive(moved)
    model.setActive(c)
    model.closeEditor(c)
    expect(model.activeEditor).toBe(moved)
  })

  it('rejects a duplicate identity already in the group', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    model.openEditor(b)

    expect(model.replaceEditor(a, make('b'))).toBe(false)
    expect(model.editors[0]).toBe(a)
    expect(a.isDisposed).toBe(false)
  })

  it('returns false for an unknown or disposed replacement', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    expect(model.replaceEditor(make('x'), make('y'))).toBe(false)

    const disposed = make('a-renamed')
    disposed.dispose()
    expect(model.replaceEditor(a, disposed)).toBe(false)
    expect(model.editors[0]).toBe(a)
  })

  it('is a no-op when the replacement is the same instance', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    expect(model.replaceEditor(a, a)).toBe(true)
    expect(model.editors[0]).toBe(a)
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

  it('setActive to already-active editor re-announces the activation', () => {
    // Regression: re-running "open X" while X is already active used to be a
    // silent no-op, so the view never re-ran its focus handling and keyboard
    // focus stayed in the side bar / quick input.
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    const activeSpy = vi.fn()
    const modelSpy = vi.fn()
    model.onDidActiveEditorChange(activeSpy)
    model.onDidChangeModel(modelSpy)
    const before = model.activationId

    model.setActive(a)

    // Active editor identity is unchanged, so onDidActiveEditorChange stays quiet…
    expect(activeSpy).not.toHaveBeenCalled()
    expect(model.activeEditor).toBe(a)
    // …but the activation is still observable to views.
    expect(model.activationId).toBe(before + 1)
    expect(modelSpy).toHaveBeenCalledWith({ kind: 'active', editor: a })
  })

  it('setActive to already-active editor honors preserveFocus', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    const before = model.activationId

    model.setActive(a, { preserveFocus: true })

    expect(model.lastActivationPreservedFocus).toBe(true)
    expect(model.activationId).toBe(before + 1)
  })

  it('setActive on unknown editor is a no-op', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    model.openEditor(a)
    const before = model.activationId
    model.setActive(b)
    expect(model.activeEditor).toBe(a)
    expect(model.activationId).toBe(before)
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

describe('EditorGroupModel — lock', () => {
  it('defaults to unlocked', () => {
    expect(new EditorGroupModel().isLocked).toBe(false)
  })

  it('lock(true)/lock(false) flips state and fires a lock event', () => {
    const model = new EditorGroupModel()
    const events: IEditorGroupModelChangeEvent[] = []
    model.onDidChangeModel((e) => events.push(e))
    model.lock(true)
    expect(model.isLocked).toBe(true)
    model.lock(false)
    expect(model.isLocked).toBe(false)
    expect(events.filter((e) => e.kind === 'lock')).toHaveLength(2)
  })

  it('lock() is a no-op (no event) when already in the requested state', () => {
    const model = new EditorGroupModel()
    const spy = vi.fn()
    model.onDidChangeModel(spy)
    model.lock(false)
    expect(spy).not.toHaveBeenCalled()
    model.lock(true)
    model.lock(true)
    expect(spy.mock.calls.filter((c) => c[0].kind === 'lock')).toHaveLength(1)
  })

  it('a locked group still accepts and activates editors at the model level', () => {
    // The lock is enforced by the routing layer (activeGroupForOpen), not the
    // model — the model itself must remain a passive container.
    const model = new EditorGroupModel()
    model.lock(true)
    const a = make('a')
    model.openEditor(a)
    expect(model.activeEditor).toBe(a)
  })
})
