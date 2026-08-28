/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/editor/monaco/MonacoModelRegistry.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  MonacoModelRegistry,
  languageForResource,
  monacoModelKey,
} from '../monaco/MonacoModelRegistry.js'

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

  it("monacoModelKey predicts the created model's uri string (Windows drive + reserved chars)", () => {
    // The document-mirror pipeline predicts a model's map key before the model
    // exists (did-save waits on it); the prediction must equal the key the model
    // itself produces. Monaco encodes the drive-letter colon (`c%3A`) and other
    // reserved characters that platform URIs leave raw.
    for (const input of [
      'file:///C:/ws/a.txt',
      'file:///D:/x/Foo (v2).ts',
      'file:///e:/w s/b,1.ts',
    ]) {
      const resource = URI.parse(input)
      const model = MonacoModelRegistry.acquire(resource, 'x')
      expect(monacoModelKey(resource)).toBe(model.uri.toString())
      MonacoModelRegistry.release(resource)
    }
  })

  it('enumerates held models so a late subscriber can catch up (bug recording)', () => {
    // Editors restored at startup create their models during the React mount,
    // which runs before AfterRestore contributions exist. A consumer that only
    // subscribes to onDidAddModel would miss exactly the files already open, so
    // it enumerates models() first — that list must hold every live model and
    // drop released ones.
    const a = URI.file('/tmp/catchup-a.ts')
    const b = URI.file('/tmp/catchup-b.ts')
    const modelA = MonacoModelRegistry.acquire(a, 'a')
    const modelB = MonacoModelRegistry.acquire(b, 'b')

    expect(MonacoModelRegistry.models()).toContain(modelA)
    expect(MonacoModelRegistry.models()).toContain(modelB)
    // Enumerating must not change refcounts, or the caller would leak the model.
    MonacoModelRegistry.release(a)
    expect(MonacoModelRegistry.models()).not.toContain(modelA)
    expect(MonacoModelRegistry.models()).toContain(modelB)
    MonacoModelRegistry.release(b)
    expect(MonacoModelRegistry.models()).toHaveLength(0)
  })
})
