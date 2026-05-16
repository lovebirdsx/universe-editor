/*---------------------------------------------------------------------------------------------
 *  Tests for the EditorInput abstract base class.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { EditorInput } from '../../workbench/editorService.js'
import { URI } from '../../base/uri.js'

class TestEditorInput extends EditorInput {
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

describe('EditorInput — identity', () => {
  it('id derives from resource URI when present', () => {
    const input = new TestEditorInput(URI.file('D:/foo.txt'), 'foo.txt')
    expect(input.id).toBe('file:///D:/foo.txt')
  })

  it('id falls back to typeId:anonymous when resource is undefined', () => {
    const input = new TestEditorInput(undefined, 'untitled')
    expect(input.id).toBe('test:anonymous')
  })

  it('legacy type / label getters proxy to typeId / getName()', () => {
    const input = new TestEditorInput(URI.file('D:/foo.txt'), 'foo.txt', 'text')
    expect(input.type).toBe('text')
    expect(input.label).toBe('foo.txt')
  })
})

describe('EditorInput — matches', () => {
  it('matches itself', () => {
    const input = new TestEditorInput(URI.file('D:/foo.txt'), 'foo.txt')
    expect(input.matches(input)).toBe(true)
  })

  it('matches another EditorInput with the same resource URI', () => {
    const a = new TestEditorInput(URI.file('D:/foo.txt'), 'foo.txt')
    const b = new TestEditorInput(URI.file('D:/foo.txt'), 'foo-renamed.txt')
    expect(a.matches(b)).toBe(true)
  })

  it('does not match when URIs differ', () => {
    const a = new TestEditorInput(URI.file('D:/foo.txt'), 'foo.txt')
    const b = new TestEditorInput(URI.file('D:/bar.txt'), 'bar.txt')
    expect(a.matches(b)).toBe(false)
  })

  it('falls back to id comparison for IEditorInput shape', () => {
    const a = new TestEditorInput(URI.file('D:/foo.txt'), 'foo.txt')
    expect(a.matches({ id: 'file:///D:/foo.txt', type: 'test', label: 'x', isDirty: false })).toBe(
      true,
    )
  })
})

describe('EditorInput — dirty / dispose events', () => {
  it('setDirty fires onDidChangeDirty exactly once per change', () => {
    const input = new TestEditorInput(URI.file('D:/foo.txt'), 'foo.txt')
    const spy = vi.fn()
    input.onDidChangeDirty(spy)
    input.setDirty(true)
    expect(spy).toHaveBeenCalledOnce()
    input.setDirty(true)
    expect(spy).toHaveBeenCalledOnce()
    input.setDirty(false)
    expect(spy).toHaveBeenCalledTimes(2)
    input.dispose()
  })

  it('dispose fires onWillDispose only once', () => {
    const input = new TestEditorInput(URI.file('D:/foo.txt'), 'foo.txt')
    const spy = vi.fn()
    input.onWillDispose(spy)
    input.dispose()
    input.dispose()
    expect(spy).toHaveBeenCalledOnce()
    expect(input.isDisposed).toBe(true)
  })
})
