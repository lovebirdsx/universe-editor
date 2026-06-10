/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/editor/monaco/MonacoModelRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { MonacoModelRegistry, languageForResource } from '../monaco/MonacoModelRegistry.js'

describe('MonacoModelRegistry', () => {
  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('acquire creates a model on first call and reuses it on second', () => {
    const uri = URI.file('/tmp/a.json')
    const m1 = MonacoModelRegistry.acquire(uri, '{"a":1}')
    const m2 = MonacoModelRegistry.acquire(uri, 'IGNORED')
    expect(m2).toBe(m1)
    expect(m1.getValue()).toBe('{"a":1}')
  })

  it('release at refcount zero disposes the model and clears the entry', () => {
    const uri = URI.file('/tmp/b.txt')
    MonacoModelRegistry.acquire(uri, 'x')
    MonacoModelRegistry.acquire(uri, 'x')
    MonacoModelRegistry.release(uri)
    expect(MonacoModelRegistry.peek(uri)).toBeDefined()
    MonacoModelRegistry.release(uri)
    expect(MonacoModelRegistry.peek(uri)).toBeUndefined()
    // extra release is a no-op
    MonacoModelRegistry.release(uri)
  })

  it('languageForResource maps known extensions, defaults plaintext', () => {
    expect(languageForResource(URI.file('/x/foo.json'))).toBe('json')
    expect(languageForResource(URI.file('/x/foo.ts'))).toBe('typescript')
    expect(languageForResource(URI.file('/x/foo.md'))).toBe('markdown')
    expect(languageForResource(URI.file('/x/foo.unknownext'))).toBe('plaintext')
    expect(languageForResource(URI.file('/x/no-extension'))).toBe('plaintext')
  })

  it('acquire applies language by extension to new models', () => {
    const uri = URI.file('/tmp/x.json')
    const model = MonacoModelRegistry.acquire(uri, '{}')
    expect(model.getLanguageId()).toBe('json')
    MonacoModelRegistry.release(uri)
  })

  it('dedupes URIs differing only by Windows drive case (workspace-symbol jump regression)', () => {
    // The editor opens with an uppercase-drive platform URI; a workspace-symbol
    // jump produces the same file as a lowercased URI (round-tripped through
    // Monaco). Both must resolve to one model — historically the second threw
    // "Cannot add model because it already exists!".
    const upper = URI.parse('file:///D:/x/Foo.ts')
    const lower = URI.parse('file:///d%3A/x/Foo.ts')
    const m1 = MonacoModelRegistry.acquire(upper, 'content')
    const m2 = MonacoModelRegistry.acquire(lower, 'IGNORED')
    expect(m2).toBe(m1)
    // The refcount is shared across both casings.
    MonacoModelRegistry.release(upper)
    expect(MonacoModelRegistry.peek(lower)).toBeDefined()
    MonacoModelRegistry.release(lower)
    expect(MonacoModelRegistry.peek(upper)).toBeUndefined()
  })
})
