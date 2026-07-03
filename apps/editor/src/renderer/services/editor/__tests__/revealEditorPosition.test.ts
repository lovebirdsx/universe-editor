/**
 * Regression: opening a cross-file markdown link with a header fragment
 * (`./foo.md#hello`) routes through Monaco's `extractSelection`, which yields a
 * range with `undefined` end fields. toRevealRange must collapse that into a
 * valid IRange so `setSelection` doesn't throw "Invalid arguments".
 */
import { describe, expect, it } from 'vitest'
import type { ITextEditorSelection } from '@universe-editor/platform'
import { toRevealRange } from '../revealEditorPosition.js'

describe('toRevealRange', () => {
  it('fills end fields from the start when they are undefined (header-fragment link)', () => {
    // Shape a single-position `#L5,1` fragment produces (no `-L..` end part).
    const partial: ITextEditorSelection = { startLineNumber: 5, startColumn: 1 }
    expect(toRevealRange(partial)).toEqual({
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 1,
    })
  })

  it('preserves a fully specified range (`#L5,1-L6,3`)', () => {
    const full: ITextEditorSelection = {
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 6,
      endColumn: 3,
    }
    expect(toRevealRange(full)).toEqual(full)
  })
})
