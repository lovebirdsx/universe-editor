/*---------------------------------------------------------------------------------------------
 *  Tests for codeBlockLinks — turning bare file paths inside a rendered code
 *  block into clickable anchors, and reading a click back to its target.
 *
 * @vitest-environment happy-dom
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  escapeHtmlText,
  linkifyFilePathsInCode,
  resolveCodeBlockLinkClick,
} from '../codeBlockLinks.js'

function makeCode(html: string): HTMLElement {
  const el = document.createElement('code')
  el.innerHTML = html
  return el
}

describe('escapeHtmlText', () => {
  it('escapes the HTML metacharacters', () => {
    expect(escapeHtmlText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
  })
})

describe('linkifyFilePathsInCode', () => {
  it('wraps a bare relative path in an anchor carrying its path', () => {
    const el = makeCode(escapeHtmlText('Content/Config/whiteList.txt'))
    linkifyFilePathsInCode(el, 'lnk')
    const a = el.querySelector('a')
    expect(a).toBeTruthy()
    expect(a?.textContent).toBe('Content/Config/whiteList.txt')
    expect(a?.dataset['path']).toBe('Content/Config/whiteList.txt')
    expect(a?.className).toBe('lnk')
  })

  it('captures a :line:col location suffix', () => {
    const el = makeCode(escapeHtmlText('see src/foo/bar.ts:10:5 here'))
    linkifyFilePathsInCode(el, 'lnk')
    const a = el.querySelector('a')
    expect(a?.dataset['path']).toBe('src/foo/bar.ts')
    expect(a?.dataset['line']).toBe('10')
    expect(a?.dataset['col']).toBe('5')
    // Surrounding text is preserved.
    expect(el.textContent).toBe('see src/foo/bar.ts:10:5 here')
  })

  it('does not link a bare filename without a directory separator', () => {
    const el = makeCode(escapeHtmlText('package.json'))
    linkifyFilePathsInCode(el, 'lnk')
    expect(el.querySelector('a')).toBeNull()
  })

  it('links paths inside colorized token spans without disturbing them', () => {
    // Simulate Monaco output: a path sitting inside one string-literal span.
    const el = makeCode('<span class="mtk5">"src/app/main.ts"</span>')
    linkifyFilePathsInCode(el, 'lnk')
    const span = el.querySelector('span.mtk5')
    expect(span).toBeTruthy()
    const a = span?.querySelector('a')
    expect(a?.dataset['path']).toBe('src/app/main.ts')
  })

  it('is idempotent — a second pass does not double-wrap', () => {
    const el = makeCode(escapeHtmlText('src/a/b.ts'))
    linkifyFilePathsInCode(el, 'lnk')
    linkifyFilePathsInCode(el, 'lnk')
    expect(el.querySelectorAll('a')).toHaveLength(1)
  })
})

describe('resolveCodeBlockLinkClick', () => {
  it('reads path/line/col back from a clicked anchor', () => {
    const el = makeCode(escapeHtmlText('src/foo/bar.ts:3:7'))
    linkifyFilePathsInCode(el, 'lnk')
    const a = el.querySelector('a')!
    expect(resolveCodeBlockLinkClick(a)).toEqual({ path: 'src/foo/bar.ts', line: 3, col: 7 })
  })

  it('returns null for a click that missed any link', () => {
    const el = makeCode(escapeHtmlText('plain text'))
    expect(resolveCodeBlockLinkClick(el.firstChild as EventTarget)).toBeNull()
  })
})
