/*---------------------------------------------------------------------------------------------
 *  Tests for AcpPromptDraftCache — the per-session unsent-draft store that lets
 *  PromptInput restore its text + range-tracked references after an editor-tab or
 *  session switch.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { AcpPromptDraftCache } from '../acpPromptDraftCache.js'
import type { PlacedRef } from '../promptRef.js'

afterEach(() => AcpPromptDraftCache._resetForTests())

describe('AcpPromptDraftCache', () => {
  it('returns undefined for an unknown session', () => {
    expect(AcpPromptDraftCache.load('nope')).toBeUndefined()
  })

  it('round-trips a draft by session id', () => {
    AcpPromptDraftCache.save('s1', { text: 'hello world' })
    expect(AcpPromptDraftCache.load('s1')).toEqual({ text: 'hello world' })
  })

  it('preserves the range-tracked refs alongside the text', () => {
    const refs: PlacedRef[] = [
      { ref: { id: '1', kind: 'file', label: 'a.ts', uri: 'file:///a.ts' }, start: 4, end: 9 },
    ]
    AcpPromptDraftCache.save('s1', { text: 'see @a.ts', refs })
    expect(AcpPromptDraftCache.load('s1')).toEqual({ text: 'see @a.ts', refs })
  })

  it('keeps sessions isolated from each other', () => {
    AcpPromptDraftCache.save('s1', { text: 'draft one' })
    AcpPromptDraftCache.save('s2', { text: 'draft two' })
    expect(AcpPromptDraftCache.load('s1')?.text).toBe('draft one')
    expect(AcpPromptDraftCache.load('s2')?.text).toBe('draft two')
  })

  it('clear removes only the targeted session', () => {
    AcpPromptDraftCache.save('s1', { text: 'a' })
    AcpPromptDraftCache.save('s2', { text: 'b' })
    AcpPromptDraftCache.clear('s1')
    expect(AcpPromptDraftCache.load('s1')).toBeUndefined()
    expect(AcpPromptDraftCache.load('s2')?.text).toBe('b')
  })
})
