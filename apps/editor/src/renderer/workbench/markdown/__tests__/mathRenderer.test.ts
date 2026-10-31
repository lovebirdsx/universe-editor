/*---------------------------------------------------------------------------------------------
 *  Tests for the KaTeX wrapper. The wrapper is the trust boundary for the
 *  dangerouslySetInnerHTML used by MathNode, so the security assertions here
 *  matter as much as the rendering ones.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { renderMathToString } from '../mathRenderer.js'
import { EMPTY_MATH_MACROS, sanitizeMathMacros } from '../mathOptions.js'

const B = '\\'

describe('renderMathToString', () => {
  it('renders inline math to KaTeX HTML plus MathML', () => {
    const html = renderMathToString('x^2', false, EMPTY_MATH_MACROS)
    expect(html).toContain('class="katex"')
    expect(html).toContain('<math')
    expect(html).not.toContain('class="katex-display"')
    expect(html).not.toContain('<script')
  })

  it('renders display math', () => {
    const html = renderMathToString(`${B}frac{1}{2}`, true, EMPTY_MATH_MACROS)
    expect(html).toContain('class="katex-display"')
  })

  it('does not emit links, images or raw HTML from trust-sensitive commands', () => {
    const cases = [
      `${B}href{javascript:alert(1)}{x}`,
      `${B}url{javascript:alert(1)}`,
      `${B}includegraphics{https://example.com/a.png}`,
      `${B}htmlData{foo=bar}{x}`,
    ]
    for (const tex of cases) {
      const html = renderMathToString(tex, false, EMPTY_MATH_MACROS)
      expect(html).not.toContain('href=')
      expect(html).not.toContain('<img')
      expect(html).not.toContain('<script')
    }
  })

  it('escapes HTML-looking TeX instead of creating elements', () => {
    const html = renderMathToString('<img src=x onerror=alert(1)>', false, EMPTY_MATH_MACROS)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;')
  })

  it('returns KaTeX error markup for invalid TeX instead of throwing', () => {
    const html = renderMathToString(`${B}frac{a}`, false, EMPTY_MATH_MACROS)
    expect(html).toContain('katex-error')
    expect(html).toContain('ParseError')
  })

  it('applies custom macros without mutating the caller object', () => {
    const macros = Object.freeze({ [`${B}RR`]: `${B}mathbb{R}` })
    const html = renderMathToString(`${B}RR`, false, macros)
    expect(html).not.toContain('katex-error')
    expect(html).toContain('double-struck')
    expect(macros).toEqual({ [`${B}RR`]: `${B}mathbb{R}` })
  })

  it('does not leak TeX-defined macros into later renders', () => {
    const first = renderMathToString(
      `${B}def${B}zzz{${B}mathbb{Q}}${B}zzz`,
      false,
      EMPTY_MATH_MACROS,
    )
    expect(first).toContain('double-struck')
    // A fresh macros object starts clean: \zzz is once again the literal
    // fallback text, not the double-struck Q defined by the previous formula.
    const second = renderMathToString(`${B}zzz`, false, EMPTY_MATH_MACROS)
    expect(second).not.toContain('double-struck')
    expect(second).toContain(`${B}zzz`)
  })

  it('reports the error colour through the theme variable', () => {
    const html = renderMathToString(`${B}frac{a}`, false, EMPTY_MATH_MACROS)
    expect(html).toContain('var(--vscode-errorForeground, #d1242f)')
  })
})

describe('sanitizeMathMacros', () => {
  it('keeps string-valued entries', () => {
    expect(sanitizeMathMacros({ [`${B}R`]: `${B}mathbb{R}`, [`${B}N`]: 'N' })).toEqual({
      [`${B}R`]: `${B}mathbb{R}`,
      [`${B}N`]: 'N',
    })
  })

  it('drops non-string values, empty keys, arrays and null', () => {
    expect(
      sanitizeMathMacros({ ok: 'x', num: 1, nil: null, arr: ['x'], '': 'empty', obj: {} }),
    ).toEqual({ ok: 'x' })
    expect(sanitizeMathMacros([])).toBe(EMPTY_MATH_MACROS)
    expect(sanitizeMathMacros(null)).toBe(EMPTY_MATH_MACROS)
    expect(sanitizeMathMacros('nope')).toBe(EMPTY_MATH_MACROS)
  })
})
