/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { computeLineDiff } from '../lineDiff.js'

describe('computeLineDiff', () => {
  it('returns empty for two empty strings', () => {
    expect(computeLineDiff('', '')).toEqual([])
  })

  it('marks all lines added for new file', () => {
    expect(computeLineDiff('', 'a\nb\n')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
  })

  it('marks all lines deleted when target is empty', () => {
    expect(computeLineDiff('x\ny', '')).toEqual([
      { kind: 'del', text: 'x' },
      { kind: 'del', text: 'y' },
    ])
  })

  it('keeps identical lines as context', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nb\nc')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ])
  })

  it('detects a single-line change as del + add', () => {
    const result = computeLineDiff('a\nB\nc', 'a\nb\nc')
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'B' },
      { kind: 'add', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ])
  })

  it('handles insertion in the middle', () => {
    const result = computeLineDiff('a\nc', 'a\nb\nc')
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'add', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ])
  })

  it('ignores a single trailing newline', () => {
    expect(computeLineDiff('a\n', 'a\n')).toEqual([{ kind: 'ctx', text: 'a' }])
  })
})
