/*---------------------------------------------------------------------------------------------
 *  Tests for codeBlockLinks — turning bare file paths inside a rendered code
 *  block into clickable anchors, and reading a click back to its target.
 *
 * @vitest-environment happy-dom
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
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

  it("walks and builds nodes from the block's own document", () => {
    // An auxiliary-window block is owned by that window's document; using the
    // main document's walker/nodes left the foreign block unlinkified.
    const win = new Window()
    const doc = win.document as unknown as Document
    const el = doc.createElement('code') as HTMLElement
    el.textContent = 'see src/a/b.ts'
    doc.body.appendChild(el)

    const mainWalker = vi.spyOn(document, 'createTreeWalker')
    const mainFragment = vi.spyOn(document, 'createDocumentFragment')
    try {
      linkifyFilePathsInCode(el, 'lnk')
    } finally {
      mainWalker.mockRestore()
      mainFragment.mockRestore()
    }

    expect(mainWalker).not.toHaveBeenCalled()
    expect(mainFragment).not.toHaveBeenCalled()
    const a = el.querySelector('a')
    expect(a?.dataset['path']).toBe('src/a/b.ts')
    expect(a?.ownerDocument).toBe(doc)
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

  it('resolves a foreign-realm anchor by shape', () => {
    // Auxiliary-window anchors fail `instanceof Element` in the main realm.
    const anchor = {
      nodeType: 1,
      tagName: 'A',
      dataset: { path: 'src/foo/bar.ts', line: '8', col: '2', endline: '10' },
      closest: (selector: string) => (selector.includes('a[data-codelink]') ? anchor : null),
    } as unknown as EventTarget
    expect(resolveCodeBlockLinkClick(anchor)).toEqual({
      path: 'src/foo/bar.ts',
      line: 8,
      col: 2,
      endLine: 10,
    })
  })
})
