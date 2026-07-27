/*---------------------------------------------------------------------------------------------
 *  Tests for AcpChatViewStateCache — the per-session scroll/selection store that
 *  lets ChatScroll restore its view after an editor-tab or session switch.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { AcpChatViewStateCache } from '../acpChatViewStateCache.js'

afterEach(() => AcpChatViewStateCache._resetForTests())

describe('AcpChatViewStateCache', () => {
  it('returns undefined for an unknown session', () => {
    expect(AcpChatViewStateCache.load('nope')).toBeUndefined()
  })

  it('round-trips saved state by session id', () => {
    AcpChatViewStateCache.save('s1', { scrollTop: 120, stuck: false, focusedKey: 'm:abc' })
    expect(AcpChatViewStateCache.load('s1')).toEqual({
      scrollTop: 120,
      stuck: false,
      focusedKey: 'm:abc',
    })
  })

  it('keeps sessions isolated from each other', () => {
    AcpChatViewStateCache.save('s1', { scrollTop: 10, stuck: true, focusedKey: null })
    AcpChatViewStateCache.save('s2', { scrollTop: 99, stuck: false, focusedKey: 't:x' })
    expect(AcpChatViewStateCache.load('s1')?.scrollTop).toBe(10)
    expect(AcpChatViewStateCache.load('s2')?.focusedKey).toBe('t:x')
  })

  it('clear removes only the targeted session', () => {
    AcpChatViewStateCache.save('s1', { scrollTop: 10, stuck: true, focusedKey: null })
    AcpChatViewStateCache.save('s2', { scrollTop: 20, stuck: true, focusedKey: null })
    AcpChatViewStateCache.clear('s1')
    expect(AcpChatViewStateCache.load('s1')).toBeUndefined()
    expect(AcpChatViewStateCache.load('s2')).toBeTruthy()
  })

  it('round-trips the scroll anchor and measurement cache', () => {
    AcpChatViewStateCache.save('s1', {
      scrollTop: 4200,
      stuck: false,
      focusedKey: null,
      anchor: { key: 'm:abc', offset: 18 },
      measurements: [
        { key: 'm:abc', size: 120 },
        { key: 't:def', size: 64 },
      ],
    })
    const loaded = AcpChatViewStateCache.load('s1')
    expect(loaded?.anchor).toEqual({ key: 'm:abc', offset: 18 })
    expect(loaded?.measurements).toEqual([
      { key: 'm:abc', size: 120 },
      { key: 't:def', size: 64 },
    ])
  })
})
