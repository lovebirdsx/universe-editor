/*---------------------------------------------------------------------------------------------
 *  Tests for AcpPromptDraftCache — the per-session unsent-draft store that lets
 *  PromptInput restore its text + recorded mentions after an editor-tab or
 *  session switch.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { AcpPromptDraftCache } from '../acpPromptDraftCache.js'

afterEach(() => AcpPromptDraftCache._resetForTests())

describe('AcpPromptDraftCache', () => {
  it('returns undefined for an unknown session', () => {
    expect(AcpPromptDraftCache.load('nope')).toBeUndefined()
  })

  it('round-trips a draft by session id', () => {
    AcpPromptDraftCache.save('s1', { text: 'hello world', mentions: [] })
    expect(AcpPromptDraftCache.load('s1')).toEqual({ text: 'hello world', mentions: [] })
  })

  it('preserves the recorded mentions alongside the text', () => {
    const mentions = [{ uri: 'file:///a.ts', name: 'a.ts' }]
    AcpPromptDraftCache.save('s1', { text: 'see @a.ts', mentions })
    expect(AcpPromptDraftCache.load('s1')).toEqual({ text: 'see @a.ts', mentions })
  })

  it('keeps sessions isolated from each other', () => {
    AcpPromptDraftCache.save('s1', { text: 'draft one', mentions: [] })
    AcpPromptDraftCache.save('s2', { text: 'draft two', mentions: [] })
    expect(AcpPromptDraftCache.load('s1')?.text).toBe('draft one')
    expect(AcpPromptDraftCache.load('s2')?.text).toBe('draft two')
  })

  it('clear removes only the targeted session', () => {
    AcpPromptDraftCache.save('s1', { text: 'a', mentions: [] })
    AcpPromptDraftCache.save('s2', { text: 'b', mentions: [] })
    AcpPromptDraftCache.clear('s1')
    expect(AcpPromptDraftCache.load('s1')).toBeUndefined()
    expect(AcpPromptDraftCache.load('s2')?.text).toBe('b')
  })
})
