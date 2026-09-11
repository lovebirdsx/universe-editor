/*---------------------------------------------------------------------------------------------
 *  Tests for AcpPromptDraftCache — the per-session unsent-draft store that lets
 *  PromptInput restore its text + range-tracked references after an editor-tab or
 *  session switch.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { AcpPromptDraftCache, MAX_DRAFT_SESSIONS } from '../acpPromptDraftCache.js'
import type { PlacedRef } from '../../promptRef.js'

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

  it('stays pinned until every input box for that session has unmounted', () => {
    const draft = { text: 'unsent' }
    AcpPromptDraftCache.save('s1', draft)
    // A layout switch can briefly mount two PromptInputs for the same session.
    AcpPromptDraftCache.pin('s1')
    AcpPromptDraftCache.pin('s1')

    const flood = (prefix: string): void => {
      for (let i = 0; i < MAX_DRAFT_SESSIONS + 2; i++) {
        AcpPromptDraftCache.save(`${prefix}-${i}`, { text: 'x' })
      }
    }

    flood('a')
    expect(AcpPromptDraftCache.load('s1')).toEqual(draft)

    // The first unmount must not unpin a box that is still on screen.
    AcpPromptDraftCache.unpin('s1')
    flood('b')
    expect(AcpPromptDraftCache.load('s1')).toEqual(draft)

    AcpPromptDraftCache.unpin('s1')
    flood('c')
    expect(AcpPromptDraftCache.load('s1')).toBeUndefined()
  })
})
