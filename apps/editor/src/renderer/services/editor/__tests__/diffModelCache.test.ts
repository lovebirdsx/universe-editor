import { afterEach, describe, expect, it, vi } from 'vitest'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import {
  _resetDiffModelCacheForTests,
  acquireDiffModels,
  discardDiffModels,
  storeDiffModels,
} from '../diffModelCache.js'

function fakeModel(text: string): monaco.editor.ITextModel {
  return {
    getValue: () => text,
    dispose: vi.fn(),
  } as unknown as monaco.editor.ITextModel
}

function store(key: string, originalText: string, modifiedText: string) {
  const original = fakeModel(originalText)
  const modified = fakeModel(modifiedText)
  storeDiffModels(key, original, modified)
  return { original, modified }
}

afterEach(() => {
  _resetDiffModelCacheForTests()
})

describe('diffModelCache', () => {
  it('hands a stored pair back on a matching acquire, then misses', () => {
    const pair = store('k', 'left', 'right')
    const hit = acquireDiffModels('k', { originalText: 'left', modifiedText: 'right' })
    expect(hit?.original).toBe(pair.original)
    expect(hit?.modified).toBe(pair.modified)
    // Acquired pairs leave the cache (the live editor owns them again).
    expect(acquireDiffModels('k', { originalText: 'left', modifiedText: 'right' })).toBeUndefined()
    expect(pair.original.dispose).not.toHaveBeenCalled()
  })

  it('disposes and misses when the reopened content no longer matches', () => {
    const pair = store('k', 'left', 'right')
    const hit = acquireDiffModels('k', { originalText: 'left', modifiedText: 're-shelved' })
    expect(hit).toBeUndefined()
    expect(pair.original.dispose).toHaveBeenCalledOnce()
    expect(pair.modified.dispose).toHaveBeenCalledOnce()
  })

  it('evicts and disposes the oldest entry past the capacity', () => {
    const pairs = Array.from({ length: 8 }, (_, i) => store(`k${i}`, `l${i}`, `r${i}`))
    const overflow = store('k8', 'l8', 'r8')
    // k0 (oldest) is gone; k1..k8 survive.
    expect(pairs[0]!.original.dispose).toHaveBeenCalledOnce()
    expect(acquireDiffModels('k0', { originalText: 'l0', modifiedText: 'r0' })).toBeUndefined()
    expect(acquireDiffModels('k1', { originalText: 'l1', modifiedText: 'r1' })).toBeDefined()
    expect(acquireDiffModels('k8', { originalText: 'l8', modifiedText: 'r8' })?.original).toBe(
      overflow.original,
    )
    for (const p of pairs.slice(1)) expect(p.original.dispose).not.toHaveBeenCalled()
  })

  it('disposes the previous pair when the same key is stored twice', () => {
    const first = store('k', 'a', 'b')
    store('k', 'c', 'd')
    expect(first.original.dispose).toHaveBeenCalledOnce()
    expect(first.modified.dispose).toHaveBeenCalledOnce()
  })

  it('discards an entry without handing it out', () => {
    const pair = store('k', 'left', 'right')
    discardDiffModels('k')
    expect(pair.original.dispose).toHaveBeenCalledOnce()
    expect(acquireDiffModels('k', { originalText: 'left', modifiedText: 'right' })).toBeUndefined()
  })
})
