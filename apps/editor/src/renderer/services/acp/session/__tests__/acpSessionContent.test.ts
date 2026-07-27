/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for readToolCallLocations — normalizing the SDK ToolCall.locations into
 *  the view-model shape (drop empty paths, coerce nullable line, undefined when empty).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { readToolCallLocations } from '../acpSessionContent.js'

describe('readToolCallLocations', () => {
  it('returns undefined for null / undefined / empty', () => {
    expect(readToolCallLocations(null)).toBeUndefined()
    expect(readToolCallLocations(undefined)).toBeUndefined()
    expect(readToolCallLocations([])).toBeUndefined()
  })

  it('keeps path and line, coercing a null line to omitted', () => {
    expect(
      readToolCallLocations([
        { path: '/a/b.ts', line: 10 },
        { path: '/c/d.ts', line: null },
      ]),
    ).toStrictEqual([{ path: '/a/b.ts', line: 10 }, { path: '/c/d.ts' }])
  })

  it('drops entries with an empty or missing path', () => {
    expect(readToolCallLocations([{ path: '', line: 1 }, { path: '/keep.ts' }])).toStrictEqual([
      { path: '/keep.ts' },
    ])
  })
})
