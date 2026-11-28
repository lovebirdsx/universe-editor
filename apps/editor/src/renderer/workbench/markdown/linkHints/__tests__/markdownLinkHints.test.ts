/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { DEFAULT_HINT_CHARS, generateHintLabels } from '../markdownLinkHints.js'

describe('generateHintLabels', () => {
  it('returns nothing for non-positive counts', () => {
    expect(generateHintLabels(0)).toEqual([])
    expect(generateHintLabels(-3)).toEqual([])
  })

  it('uses single chars while they suffice', () => {
    const labels = generateHintLabels(3, 'abc')
    expect(labels).toEqual(['a', 'b', 'c'])
  })

  it('gives a single link a non-empty one-char label', () => {
    expect(generateHintLabels(1, 'abc')).toEqual(['a'])
    expect(generateHintLabels(1)).toEqual(['a'])
  })

  it('matches vimium spread: two chars, three links', () => {
    // BFS over {a,b}: expand "" -> a,b ; need 3, expand "a" -> aa,ab ;
    // leaves reversed+sorted -> aa, b, ab (short label "b" spread to the middle).
    expect(generateHintLabels(3, 'ab')).toEqual(['aa', 'b', 'ab'])
  })

  it('produces exactly `count` labels', () => {
    for (const n of [1, 5, 9, 10, 50, 81, 82, 200]) {
      expect(generateHintLabels(n)).toHaveLength(n)
    }
  })

  it('produces unique labels', () => {
    const labels = generateHintLabels(200)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('is prefix-free: no label is a prefix of another', () => {
    const labels = generateHintLabels(200)
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue
        expect(b.startsWith(a)).toBe(false)
      }
    }
  })

  it('only uses characters from the charset', () => {
    const labels = generateHintLabels(100)
    const allowed = new Set(DEFAULT_HINT_CHARS)
    for (const label of labels) {
      for (const ch of label) expect(allowed.has(ch)).toBe(true)
    }
  })

  it('falls back to the default charset when given fewer than two chars', () => {
    expect(generateHintLabels(3, '')).toEqual(generateHintLabels(3))
    expect(generateHintLabels(3, 'x')).toEqual(generateHintLabels(3))
  })
})
