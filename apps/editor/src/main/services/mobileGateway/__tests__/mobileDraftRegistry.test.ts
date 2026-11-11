import { describe, expect, it } from 'vitest'
import { MAX_DRAFT_ENTRIES, MobileDraftRegistry, isDraftEmpty } from '../mobileDraftRegistry.js'

const KEY = '1:s1'

describe('MobileDraftRegistry', () => {
  it('assigns monotonically increasing revisions and skips unchanged content', () => {
    const registry = new MobileDraftRegistry()

    const first = registry.setFromRenderer(KEY, { text: 'a', caret: 1, images: [] })
    expect(first.changed).toBe(true)
    expect(first.state?.revision).toBe(1)
    expect(first.state?.source).toBe('pc')

    const same = registry.setFromRenderer(KEY, { text: 'a', caret: 1, images: [] })
    expect(same.changed).toBe(false)
    expect(same.state?.revision).toBe(1)

    const next = registry.setFromRenderer(KEY, { text: 'ab', caret: 2, images: [] })
    expect(next.changed).toBe(true)
    expect(next.state?.revision).toBe(2)
  })

  it('keeps refs only while the phone leaves the text untouched', () => {
    const registry = new MobileDraftRegistry()
    registry.setFromRenderer(KEY, {
      text: 'see @file.ts',
      caret: 12,
      images: [],
      refs: [{ id: 'r1', kind: 'file', label: 'file.ts', start: 4, end: 12 }],
      contexts: [{ relPath: 'src/a.ts', startLine: 1, endLine: 2 }],
    })

    const caretOnly = registry.setFromPhone(KEY, { text: 'see @file.ts', caret: 4, images: [] })
    expect(caretOnly.state?.refs).toHaveLength(1)
    expect(caretOnly.state?.contexts).toHaveLength(1)
    expect(caretOnly.state?.source).toBe('mobile')

    const edited = registry.setFromPhone(KEY, { text: 'see @file.ts now', caret: 16, images: [] })
    expect(edited.state?.refs).toBeUndefined()
    expect(edited.state?.contexts).toHaveLength(1)
  })

  it('clears the entry but returns an empty state for broadcasting', () => {
    const registry = new MobileDraftRegistry()
    registry.setFromRenderer(KEY, { text: 'draft', caret: 5, images: [] })
    const cleared = registry.setFromRenderer(KEY, undefined)

    expect(registry.get(KEY)).toBeUndefined()
    expect(cleared.changed).toBe(true)
    expect(cleared.state).toBeDefined()
    expect(isDraftEmpty(cleared.state!)).toBe(true)
    expect(cleared.state?.revision).toBe(2)
  })

  it('removes every entry belonging to a closed window', () => {
    const registry = new MobileDraftRegistry()
    registry.setFromRenderer('1:s1', { text: 'a', caret: 1, images: [] })
    registry.setFromRenderer('1:s2', { text: 'b', caret: 1, images: [] })
    registry.setFromRenderer('2:s1', { text: 'c', caret: 1, images: [] })

    registry.deleteWindow(1)

    expect(registry.get('1:s1')).toBeUndefined()
    expect(registry.get('1:s2')).toBeUndefined()
    expect(registry.get('2:s1')).toBeDefined()
  })

  it('treats attachments as content', () => {
    const registry = new MobileDraftRegistry()
    const draft = {
      text: '',
      caret: 0,
      images: [{ id: 'img', source: 'pc' as const, mimeType: 'image/png', byteSize: 10 }],
      files: [{ id: 'f1', name: 'a.txt', byteSize: 3 }],
    }
    expect(registry.setFromRenderer(KEY, draft).changed).toBe(true)
    expect(registry.setFromRenderer(KEY, draft).changed).toBe(false)
  })

  it('evicts the oldest entry when the registry grows past its cap', () => {
    const registry = new MobileDraftRegistry()
    for (let index = 0; index < MAX_DRAFT_ENTRIES + 1; index += 1) {
      registry.setFromRenderer(`1:s${index}`, { text: `${index}`, caret: 1, images: [] })
    }

    expect(registry.get('1:s0')).toBeUndefined()
    expect(registry.get(`1:s${MAX_DRAFT_ENTRIES}`)).toBeDefined()
  })
})
