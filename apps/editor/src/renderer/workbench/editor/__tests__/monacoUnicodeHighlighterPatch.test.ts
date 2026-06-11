/*---------------------------------------------------------------------------------------------
 *  Verify the unicodeHighlighter patch:
 *   1. wraps `_updateState` with a hasModel guard + try/catch before BannerController
 *   2. is idempotent (a second pass does not re-wrap)
 *   3. leaves sources without the anchor untouched
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { patchUnicodeHighlighterSource } from '../monaco/monacoUnicodeHighlighterPatch.js'

const SAMPLE = `        this._updateState = (state) => {
            if (state && state.hasMore) {
                this._bannerController.show({ id: 'unicodeHighlightBanner' });
            }
            else {
                this._bannerController.hide();
            }
        };
        this._bannerController = this._register(instantiationService.createInstance(BannerController, _editor));`

describe('patchUnicodeHighlighterSource', () => {
  it('wraps _updateState with a hasModel guard and try/catch', () => {
    const patched = patchUnicodeHighlighterSource(SAMPLE)
    expect(patched).toContain('const __ueOrigUpdateState = this._updateState;')
    expect(patched).toContain('if (!this._editor.hasModel()) { return; }')
    expect(patched).toContain('try { __ueOrigUpdateState(state); } catch (e) { }')
    // The wrapper is spliced in *before* the BannerController is created, so the
    // wrapped reference is the one the highlighter later captures.
    expect(patched.indexOf('__ueOrigUpdateState')).toBeLessThan(
      patched.indexOf('createInstance(BannerController'),
    )
  })

  it('is idempotent', () => {
    const once = patchUnicodeHighlighterSource(SAMPLE)
    const twice = patchUnicodeHighlighterSource(once)
    expect(twice).toBe(once)
    const wrappers = twice.match(/const __ueOrigUpdateState = this\._updateState;/g)
    expect(wrappers).toHaveLength(1)
  })

  it('returns sources without the anchor unchanged', () => {
    const unrelated = 'export const x = 1;\n'
    expect(patchUnicodeHighlighterSource(unrelated)).toBe(unrelated)
  })
})
