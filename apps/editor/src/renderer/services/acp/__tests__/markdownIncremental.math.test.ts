/*---------------------------------------------------------------------------------------------
 *  Incremental streaming equivalence for LaTeX math. A blank line inside a
 *  `$$…$$` block must never become a safe split point: cutting there would leave
 *  two unterminated math blocks instead of one formula. Blank lines inside code
 *  fences are already excluded; math blocks containing fences (and vice versa)
 *  must not confuse either mask.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { parseMarkdown, type MdNode } from '../markdownRenderer.js'
import { createMarkdownStreamCache, parseMarkdownStreaming } from '../markdownIncremental.js'

/** Feed `final` one character at a time, returning the last incremental result. */
function streamChars(final: string): readonly MdNode[] {
  const cache = createMarkdownStreamCache()
  let last: readonly MdNode[] = []
  for (let i = 1; i <= final.length; i++) {
    last = parseMarkdownStreaming(final.slice(0, i), cache)
  }
  return last
}

/** Same as {@link streamChars}, for a parser configured without math. */
function streamCharsWithoutMath(final: string): readonly MdNode[] {
  const cache = createMarkdownStreamCache()
  const parse = (input: string): readonly MdNode[] => parseMarkdown(input, { math: false })
  let last: readonly MdNode[] = []
  for (let i = 1; i <= final.length; i++) {
    last = parseMarkdownStreaming(final.slice(0, i), cache, parse, false)
  }
  return last
}

describe('parseMarkdownStreaming — math equivalence', () => {
  const cases: Record<string, string> = {
    'single-line block': 'intro\n\n$$x$$\n\nafter',
    'multi-line block with blank line inside': 'intro\n\n$$\nx + y\n\ny\n$$\n\nafter',
    'multi-line block with fence inside': 'intro\n\n$$\n```\nx\n```\n$$\n\nafter',
    'unterminated block runs to EOF': 'intro\n\n$$\nx + y',
    'unterminated block followed by blank lines': 'intro\n\n$$\nx + y\n\n\n',
    'fence containing $$ pairs': 'before\n\n```\n$$\nx\n\ny\n$$\n```\n\nafter',
    'inline math in paragraphs': 'math $x^2$ here\n\nand $y$ there\n\n$$z$$',
    'blockquote with math and a quote break': '> $$\n> x\n\n> y\n> $$\n\nafter',
    'list item math opened on the item line': '- $$\n  x\n\n  y\n  $$\n\n- next\n  z',
    'list item math as an indented child': '- item\n  $$\n  x\n\n  y\n  $$\n\nafter',
    'list item math ended by a dedented closer': '- $$\n  x\n\n$$\ny\n\nz',
    'unterminated list math continued after a blank': '- $$\n  x\n\n  y\n\nz',
    'indented child math ended by dedented content':
      '- 公式：\n  $$\n  E = mc^2\n$$\n\n说明文字\n\n$$\na = b\n\nc = d\n$$',
    'list child math followed by another formula': '- item\n  $$\n  x\n\noutside\n\n  $$\ny\n\nz',
    'loose list around a math block': '- one\n\n- $$\n  x\n  $$\n\n- three',
    'math after a sealed paragraph': 'para\n\n$$\nx\n\ny\n$$\n\ntail',
  }

  for (const [name, input] of Object.entries(cases)) {
    it(`final output matches parseMarkdown: ${name}`, () => {
      const cache = createMarkdownStreamCache()
      expect(parseMarkdownStreaming(input, cache)).toEqual(parseMarkdown(input))
    })

    it(`char-by-char streaming matches parseMarkdown: ${name}`, () => {
      expect(streamChars(input)).toEqual(parseMarkdown(input))
    })
  }

  it('does not seal a prefix at a blank line inside a math block', () => {
    const input = 'para\n\n$$\nx\n\ny\n$$\n\ntail'
    const cache = createMarkdownStreamCache()
    parseMarkdownStreaming(input, cache)
    // The only safe split is the blank after the closing `$$` (line 6). The
    // blank inside the formula (line 4) must not seal the head there.
    expect(cache.sealedText).toBe('para\n\n$$\nx\n\ny\n$$\n\n')
  })

  it('does not seal at a blank line inside list-item math', () => {
    const cache = createMarkdownStreamCache()
    parseMarkdownStreaming('- $$\n  x\n\n', cache)
    expect(cache.sealedText).toBe('')
  })

  it('seals at the blank that provably ends the list item', () => {
    // Dedented content after the blank proves the item cannot continue, so the
    // second parse of this prefix appends to a stable list rather than
    // extending its math child.
    const cache = createMarkdownStreamCache()
    parseMarkdownStreaming('- $$\n  x\n\nz', cache)
    expect(cache.sealedText).toBe('- $$\n  x\n\n')
  })

  it('starts sealing only after the math block closes', () => {
    const cache = createMarkdownStreamCache()
    parseMarkdownStreaming('$$\nx\n\n', cache)
    expect(cache.sealedText).toBe('')
    parseMarkdownStreaming('$$\nx\n\ny', cache)
    expect(cache.sealedText).toBe('')
    parseMarkdownStreaming('$$\nx\n\ny\n$$\n\n', cache)
    expect(cache.sealedText).toBe('$$\nx\n\ny\n$$\n\n')
  })

  it('keeps math AST identity stable while the tail grows', () => {
    const cache = createMarkdownStreamCache()
    parseMarkdownStreaming('$$\nx\n\ny\n$$\n\n', cache)
    const firstMath = cache.sealedNodes.find((n) => n.type === 'math_block')
    expect(firstMath).toMatchObject({ type: 'math_block', tex: 'x\n\ny' })

    const nodes = parseMarkdownStreaming('$$\nx\n\ny\n$$\n\ntail', cache)
    const repeated = nodes.find((n) => n.type === 'math_block')
    expect(Object.is(repeated, firstMath)).toBe(true)
    expect(cache.sealedText).toBe('$$\nx\n\ny\n$$\n\n')
  })

  it('matches parseMarkdown with math disabled', () => {
    // A `$$` line is a paragraph and the fence below runs to EOF; the mask must
    // follow the parser's options or the blank inside the fence looks safe.
    const input = '$$\n```\n> $$\nx\n\n> y\n  $$'
    expect(streamCharsWithoutMath(input)).toEqual(parseMarkdown(input, { math: false }))
  })

  it('can seal at a blank line that only math would have covered', () => {
    const parse = (input: string): readonly MdNode[] => parseMarkdown(input, { math: false })
    const cache = createMarkdownStreamCache()
    parseMarkdownStreaming('$$\nx\n\n', cache, parse, false)
    expect(cache.sealedText).toBe('$$\nx\n\n')
  })
})
