/*---------------------------------------------------------------------------------------------
 *  Tests for findMarkdownAnchor — exact id first, GitHub-style heading slug as
 *  the fallback. Needs a DOM (querySelector), so it is registered in
 *  vitest.config.ts `rendererDomTests`.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { findMarkdownAnchor } from '../markdownAnchors.js'

function root(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

describe('findMarkdownAnchor', () => {
  it('prefers an exact id match over the slug fallback', () => {
    // `Foo_Bar` slugifies to `foobar`; both elements exist — the exact one wins.
    const r = root('<span data-anchor="Foo_Bar"></span><h2 data-anchor="foobar"></h2>')
    expect(findMarkdownAnchor(r, '#Foo_Bar')?.getAttribute('data-anchor')).toBe('Foo_Bar')
  })

  it('falls back to the slugified heading lookup', () => {
    const r = root('<h2 data-anchor="子结构italkitem"></h2>')
    expect(findMarkdownAnchor(r, '#子结构italkitem')?.tagName).toBe('H2')
    // Non-slug fragments written against the heading text still resolve.
    expect(findMarkdownAnchor(r, '#子结构：ITalkItem')?.tagName).toBe('H2')
  })

  it('decodes percent-escapes before matching', () => {
    const r = root('<span data-anchor="tbl-子系统"></span>')
    expect(findMarkdownAnchor(r, '#tbl-%E5%AD%90%E7%B3%BB%E7%BB%9F')).not.toBeNull()
  })

  it('returns null when nothing matches', () => {
    const r = root('<h2 data-anchor="other"></h2>')
    expect(findMarkdownAnchor(r, '#missing')).toBeNull()
    expect(findMarkdownAnchor(r, '#')).toBeNull()
  })
})
