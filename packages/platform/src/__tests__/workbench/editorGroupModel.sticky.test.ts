/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupModel — sticky tabs (VSCode "Pin Editor" parity).
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

function labels(model: EditorGroupModel): string[] {
  return model.editors.map((e) => e.getName())
}

describe('EditorGroupModel — sticky', () => {
  it('sticks an editor to the front of the tab row', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    const c = make('c')
    model.openEditor(a)
    model.openEditor(b)
    model.openEditor(c)

    model.stickEditor(b)

    expect(labels(model)).toEqual(['b', 'a', 'c'])
    expect(model.stickyCount).toBe(1)
    expect(model.isSticky(b)).toBe(true)
    expect(model.isSticky(a)).toBe(false)
    expect(model.isSticky(c)).toBe(false)
  })

  it('appends subsequent sticks to the end of the sticky region', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const b = make('b')
    const c = make('c')
    model.openEditor(a)
    model.openEditor(b)
    model.openEditor(c)

    model.stickEditor(b)
    model.stickEditor(c)

    expect(labels(model)).toEqual(['b', 'c', 'a'])
    expect(model.stickyCount).toBe(2)
  })

  it('stick is a no-op for an already-sticky editor', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    model.stickEditor(a)
    const events: IEditorGroupModelChangeEvent[] = []
    model.onDidChangeModel((e) => events.push(e))

    model.stickEditor(a)

    expect(events).toEqual([])
    expect(model.stickyCount).toBe(1)
  })

  it('sticking a preview editor pins it (clears the preview slot)', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a, { pinned: false })
    expect(model.previewEditor).toBe(a)
    const events: IEditorGroupModelChangeEvent[] = []
    model.onDidChangeModel((e) => events.push(e))

    model.stickEditor(a)

    expect(model.previewEditor).toBeUndefined()
    expect(model.isPinned(a)).toBe(true)
    expect(model.isSticky(a)).toBe(true)
    expect(events.map((e) => e.kind)).toEqual(['pin', 'sticky'])
  })

  it('unstick moves the editor to the first non-sticky position', () => {
    const model = new EditorGroupModel()
    const s1 = make('s1')
    const s2 = make('s2')
    const a = make('a')
    const b = make('b')
    model.openEditor(s1)
    model.openEditor(s2)
    model.openEditor(a)
    model.openEditor(b)
    model.stickEditor(s1)
    model.stickEditor(s2)
    expect(labels(model)).toEqual(['s1', 's2', 'a', 'b'])

    model.unstickEditor(s1)

    expect(labels(model)).toEqual(['s2', 's1', 'a', 'b'])
    expect(model.stickyCount).toBe(1)
    expect(model.isSticky(s1)).toBe(false)
    expect(model.isSticky(s2)).toBe(true)
  })

  it('unstick of the last sticky editor keeps order and resets the region', () => {
    const model = new EditorGroupModel()
    const s1 = make('s1')
    const a = make('a')
    model.openEditor(s1)
    model.openEditor(a)
    model.stickEditor(s1)

    model.unstickEditor(s1)

    expect(labels(model)).toEqual(['s1', 'a'])
    expect(model.stickyCount).toBe(0)
  })

  it('unstick is a no-op for a non-sticky editor', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a)
    const events: IEditorGroupModelChangeEvent[] = []
    model.onDidChangeModel((e) => events.push(e))

    model.unstickEditor(a)

    expect(events).toEqual([])
  })

  it('isSticky is false for an editor not in the group', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    const outsider = make('outsider')
    model.openEditor(a)
    model.stickEditor(a)
    expect(model.isSticky(outsider)).toBe(false)
  })

  describe('moveEditor boundary crossing', () => {
    it('moving a non-sticky editor into the sticky region sticks it', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      const b = make('b')
      model.openEditor(s1)
      model.openEditor(a)
      model.openEditor(b)
      model.stickEditor(s1)
      const events: IEditorGroupModelChangeEvent[] = []
      model.onDidChangeModel((e) => events.push(e))

      model.moveEditor(a, 0)

      expect(labels(model)).toEqual(['a', 's1', 'b'])
      expect(model.stickyCount).toBe(2)
      expect(model.isSticky(a)).toBe(true)
      expect(events.map((e) => e.kind)).toEqual(['move', 'sticky'])
    })

    it('moving a sticky editor out of the region unsticks it', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      const b = make('b')
      model.openEditor(s1)
      model.openEditor(a)
      model.openEditor(b)
      model.stickEditor(s1)

      model.moveEditor(s1, 2)

      expect(labels(model)).toEqual(['a', 'b', 's1'])
      expect(model.stickyCount).toBe(0)
      expect(model.isSticky(s1)).toBe(false)
    })

    it('moving within the sticky region fires no sticky event', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const s2 = make('s2')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(s2)
      model.openEditor(a)
      model.stickEditor(s1)
      model.stickEditor(s2)
      const events: IEditorGroupModelChangeEvent[] = []
      model.onDidChangeModel((e) => events.push(e))

      model.moveEditor(s1, 1)

      expect(labels(model)).toEqual(['s2', 's1', 'a'])
      expect(model.stickyCount).toBe(2)
      expect(events.map((e) => e.kind)).toEqual(['move'])
    })

    it('an out-of-range target clamps into the region and unsticks', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const s2 = make('s2')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(s2)
      model.openEditor(a)
      model.stickEditor(s1)
      model.stickEditor(s2)
      const events: IEditorGroupModelChangeEvent[] = []
      model.onDidChangeModel((e) => events.push(e))

      // Asking for index 99 clamps to the last slot — outside the region.
      model.moveEditor(s1, 99)

      expect(labels(model)).toEqual(['s2', 'a', 's1'])
      expect(model.stickyCount).toBe(1)
      expect(model.isSticky(s1)).toBe(false)
      expect(events.map((e) => e.kind)).toEqual(['move', 'sticky'])
    })

    it('a negative target clamps to index 0 and keeps a sticky editor sticky', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(a)
      model.stickEditor(s1)

      model.moveEditor(s1, -5)

      expect(labels(model)).toEqual(['s1', 'a'])
      expect(model.stickyCount).toBe(1)
      expect(model.isSticky(s1)).toBe(true)
    })
  })

  describe('openEditor insert positions', () => {
    it('a non-sticky open with an explicit index is clamped past the sticky region', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(a)
      model.stickEditor(s1)

      const b = make('b')
      model.openEditor(b, { index: 0 })

      expect(labels(model)).toEqual(['s1', 'b', 'a'])
      expect(model.isSticky(b)).toBe(false)
    })

    it('openEditor with sticky:true lands at the end of the sticky region', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      model.openEditor(s1, { sticky: true })
      const s2 = make('s2')
      model.openEditor(s2, { sticky: true })

      expect(labels(model)).toEqual(['s1', 's2'])
      expect(model.stickyCount).toBe(2)
      expect(model.isPinned(s1)).toBe(true)
      expect(model.previewEditor).toBeUndefined()
    })

    it('openEditor with sticky:true on an existing editor sticks it', () => {
      const model = new EditorGroupModel()
      const a = make('a')
      const b = make('b')
      model.openEditor(a)
      model.openEditor(b)

      model.openEditor(b, { sticky: true })

      expect(labels(model)).toEqual(['b', 'a'])
      expect(model.isSticky(b)).toBe(true)
      expect(model.count).toBe(2)
    })

    it('a preview open never lands inside the sticky region', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      model.openEditor(s1, { sticky: true })

      const p = make('p')
      model.openEditor(p, { pinned: false })

      expect(labels(model)).toEqual(['s1', 'p'])
      expect(model.previewEditor).toBe(p)
      expect(model.isSticky(p)).toBe(false)
    })
  })

  describe('close/detach cursor adjustment', () => {
    it('closing a sticky editor shrinks the region', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const s2 = make('s2')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(s2)
      model.openEditor(a)
      model.stickEditor(s1)
      model.stickEditor(s2)

      model.closeEditor(s1)

      expect(labels(model)).toEqual(['s2', 'a'])
      expect(model.stickyCount).toBe(1)
      expect(model.isSticky(s2)).toBe(true)
    })

    it('closing every sticky editor resets the cursor; later closes do not underflow', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(a)
      model.stickEditor(s1)

      model.closeEditor(s1)
      expect(model.stickyCount).toBe(0)
      model.closeEditor(a)
      expect(model.stickyCount).toBe(0)
    })

    it('detaching a sticky editor shrinks the region', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(a)
      model.stickEditor(s1)

      model.detachEditor(s1)

      expect(model.stickyCount).toBe(0)
      expect(s1.disposed).toBe(false)
    })
  })

  describe('closeAllEditors', () => {
    it('excludeSticky keeps the sticky region and disposes the rest', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      const b = make('b')
      model.openEditor(s1)
      model.openEditor(a)
      model.openEditor(b)
      model.stickEditor(s1)
      model.setActive(a)

      model.closeAllEditors({ excludeSticky: true })

      expect(labels(model)).toEqual(['s1'])
      expect(model.stickyCount).toBe(1)
      expect(a.disposed).toBe(true)
      expect(b.disposed).toBe(true)
      expect(s1.disposed).toBe(false)
      // The active editor was closed — fall back to a survivor.
      expect(model.activeEditor).toBe(s1)
    })

    it('excludeSticky with a sticky active editor keeps it active', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(a)
      model.stickEditor(s1)
      model.setActive(s1)

      model.closeAllEditors({ excludeSticky: true })

      expect(model.activeEditor).toBe(s1)
    })

    it('excludeSticky is a no-op when only sticky editors exist', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      model.openEditor(s1)
      model.stickEditor(s1)
      const events: IEditorGroupModelChangeEvent[] = []
      model.onDidChangeModel((e) => events.push(e))

      model.closeAllEditors({ excludeSticky: true })

      expect(events).toEqual([])
      expect(labels(model)).toEqual(['s1'])
    })

    it('full close resets the cursor', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      model.openEditor(s1)
      model.openEditor(a)
      model.stickEditor(s1)

      model.closeAllEditors()

      expect(model.count).toBe(0)
      expect(model.stickyCount).toBe(0)
      expect(model.activeEditor).toBeUndefined()
    })

    it('excludeSticky evicts the preview editor when it sits past the region', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      model.openEditor(s1, { sticky: true })
      const p = make('p')
      model.openEditor(p, { pinned: false })

      model.closeAllEditors({ excludeSticky: true })

      expect(model.previewEditor).toBeUndefined()
      expect(p.disposed).toBe(true)
      expect(labels(model)).toEqual(['s1'])
    })
  })

  describe('getNextNonStickyMruEditor', () => {
    it('returns the MRU editor that is not sticky', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      const a = make('a')
      const b = make('b')
      model.openEditor(s1)
      model.openEditor(a)
      model.openEditor(b)
      model.stickEditor(s1)
      model.setActive(s1)

      expect(model.getNextNonStickyMruEditor()).toBe(b)
    })

    it('returns undefined when every editor is sticky', () => {
      const model = new EditorGroupModel()
      const s1 = make('s1')
      model.openEditor(s1)
      model.stickEditor(s1)

      expect(model.getNextNonStickyMruEditor()).toBeUndefined()
    })
  })

  it('sticking a dirty preview occupant protects it from the next preview open', () => {
    const model = new EditorGroupModel()
    const a = make('a')
    model.openEditor(a, { pinned: false })
    a.isDirty = true
    model.stickEditor(a)

    const b = make('b')
    model.openEditor(b, { pinned: false })

    expect(model.count).toBe(2)
    expect(model.previewEditor).toBe(b)
    expect(labels(model)).toEqual(['a', 'b'])
    expect(a.disposed).toBe(false)
  })
})
