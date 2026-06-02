/*---------------------------------------------------------------------------------------------
 *  Verify the unicodeHighlighter patch:
 *   1. injects the `hasModel()` guard into `_updateState`
 *   2. is idempotent (a second pass does not duplicate the guard)
 *   3. leaves sources without the target untouched
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { patchUnicodeHighlighterSource } from '../monaco/monacoUnicodeHighlighterPatch.js'

const SAMPLE = `        this._updateState = (state) => {
            if (state && state.hasMore) {
                this._bannerController.show({ id: 'unicodeHighlightBanner' });
            }
        };`

describe('patchUnicodeHighlighterSource', () => {
  it('injects the hasModel guard into _updateState', () => {
    const patched = patchUnicodeHighlighterSource(SAMPLE)
    expect(patched).toContain('if (!this._editor.hasModel()) { return; }')
    expect(patched).toContain('this._updateState = (state) => {')
  })

  it('is idempotent', () => {
    const once = patchUnicodeHighlighterSource(SAMPLE)
    const twice = patchUnicodeHighlighterSource(once)
    expect(twice).toBe(once)
    const guards = twice.match(/if \(!this\._editor\.hasModel\(\)\) \{ return; \}/g)
    expect(guards).toHaveLength(1)
  })

  it('returns sources without the target unchanged', () => {
    const unrelated = 'export const x = 1;\n'
    expect(patchUnicodeHighlighterSource(unrelated)).toBe(unrelated)
  })
})
