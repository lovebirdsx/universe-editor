/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/workbench/editorService.ts
 *  Covers the EditorInput base class (dirty/label/dispose events, matches) and the
 *  EditorRegistry (provider registration / lookup / deserialize fallbacks).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  EditorInput,
  EditorRegistry,
  type IEditorInput,
  type IEditorProvider,
} from '../../workbench/editorService.js'
import { URI } from '../../base/uri.js'

class TestInput extends EditorInput {
  constructor(
    private readonly _resource: URI | undefined,
    private readonly _name = 'test',
  ) {
    super()
  }
  get typeId(): string {
    return 'test'
  }
  get resource(): URI | undefined {
    return this._resource
  }
  getName(): string {
    return this._name
  }
}

describe('EditorInput', () => {
  it('derives id from resource when available', () => {
    const uri = URI.file('/tmp/a.txt')
    const input = new TestInput(uri)
    expect(input.id).toBe(uri.toString())
    input.dispose()
  })

  it('falls back to a typeId-based id without a resource', () => {
    const input = new TestInput(undefined)
    expect(input.id).toBe('test:anonymous')
    input.dispose()
  })

  it('legacy aliases (type/label) mirror typeId/getName', () => {
    const input = new TestInput(URI.file('/tmp/a.txt'), 'My Name')
    expect(input.type).toBe('test')
    expect(input.label).toBe('My Name')
    input.dispose()
  })

  it('setDirty fires onDidChangeDirty only on change', () => {
    const input = new TestInput(URI.file('/tmp/a.txt'))
    const spy = vi.fn()
    input.onDidChangeDirty(spy)
    input.setDirty(true)
    expect(input.isDirty).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
    input.setDirty(true) // no change → no fire
    expect(spy).toHaveBeenCalledOnce()
    input.dispose()
  })

  it('isDirty setter routes through setDirty', () => {
    const input = new TestInput(URI.file('/tmp/a.txt'))
    const spy = vi.fn()
    input.onDidChangeDirty(spy)
    input.isDirty = true
    expect(input.isDirty).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
    input.dispose()
  })

  it('matches by shared resource URI', () => {
    const a = new TestInput(URI.file('/tmp/same.txt'))
    const b = new TestInput(URI.file('/tmp/same.txt'), 'different name')
    expect(a.matches(b)).toBe(true)
    a.dispose()
    b.dispose()
  })

  it('matches by id when resources are absent', () => {
    const a = new TestInput(undefined)
    const b: IEditorInput = { id: 'test:anonymous', type: 'test', label: 'x', isDirty: false }
    expect(a.matches(b)).toBe(true)
    a.dispose()
  })

  it('does not match inputs with different resources', () => {
    const a = new TestInput(URI.file('/tmp/a.txt'))
    const b = new TestInput(URI.file('/tmp/b.txt'))
    expect(a.matches(b)).toBe(false)
    a.dispose()
    b.dispose()
  })

  it('dispose fires onWillDispose once and flips isDisposed', () => {
    const input = new TestInput(URI.file('/tmp/a.txt'))
    const spy = vi.fn()
    input.onWillDispose(spy)
    expect(input.isDisposed).toBe(false)
    input.dispose()
    expect(input.isDisposed).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
    input.dispose() // idempotent
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('EditorRegistry', () => {
  const makeProvider = (overrides: Partial<IEditorProvider> = {}): IEditorProvider => ({
    typeId: 'reg.test',
    componentKey: 'reg.test.component',
    ...overrides,
  })

  it('registers and looks up a provider', () => {
    const provider = makeProvider()
    const d = EditorRegistry.registerEditorProvider(provider)
    expect(EditorRegistry.getProvider('reg.test')).toBe(provider)
    d.dispose()
    expect(EditorRegistry.getProvider('reg.test')).toBeUndefined()
  })

  it('deserialize returns null when no provider is registered', () => {
    expect(EditorRegistry.deserialize('reg.missing', {})).toBeNull()
  })

  it('deserialize returns null when the provider has no deserialize hook', () => {
    const d = EditorRegistry.registerEditorProvider(makeProvider({ typeId: 'reg.nohook' }))
    expect(EditorRegistry.deserialize('reg.nohook', {})).toBeNull()
    d.dispose()
  })

  it('deserialize delegates to the provider hook', () => {
    const input = new TestInput(URI.file('/tmp/d.txt'))
    const d = EditorRegistry.registerEditorProvider(
      makeProvider({ typeId: 'reg.hook', deserialize: () => input }),
    )
    expect(EditorRegistry.deserialize('reg.hook', { any: 'data' })).toBe(input)
    d.dispose()
    input.dispose()
  })

  it('deserialize swallows provider errors and returns null', () => {
    const d = EditorRegistry.registerEditorProvider(
      makeProvider({
        typeId: 'reg.throws',
        deserialize: () => {
          throw new Error('boom')
        },
      }),
    )
    expect(EditorRegistry.deserialize('reg.throws', {})).toBeNull()
    d.dispose()
  })
})
