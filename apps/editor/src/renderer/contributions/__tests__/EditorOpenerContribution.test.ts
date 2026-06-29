/**
 * Regression: opening a cross-file markdown link with a header fragment
 * (`./foo.md#hello`) routes through Monaco's `extractSelection`, which yields a
 * range with `undefined` end fields. normalizeOpenRange must collapse that into a
 * valid IRange so `setSelection` doesn't throw "Invalid arguments".
 */
import { describe, expect, it } from 'vitest'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { normalizeOpenRange } from '../EditorOpenerContribution.js'

describe('normalizeOpenRange', () => {
  it('fills end fields from the start when they are undefined (header-fragment link)', () => {
    // Shape monaco's extractSelection produces for `#L5,1` (no `-L..` end part).
    const partial = {
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: undefined,
      endColumn: undefined,
    } as unknown as monaco.IRange
    expect(normalizeOpenRange(partial)).toEqual({
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 1,
    })
  })

  it('preserves a fully specified range (`#L5,1-L6,3`)', () => {
    const full: monaco.IRange = {
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 6,
      endColumn: 3,
    }
    expect(normalizeOpenRange(full)).toEqual(full)
  })
})
