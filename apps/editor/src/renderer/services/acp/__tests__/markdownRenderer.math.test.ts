/*---------------------------------------------------------------------------------------------
 *  Tests for LaTeX math parsing in the markdown renderer:
 *    - block math (`$$` at line start, single- and multi-line, unterminated)
 *    - inline math (`$…$` and mid-paragraph `$$…$$`)
 *    - boundaries: money, word characters, CJK, escapes, code spans
 *    - opt-out via `math: false` (including nested blocks)
 *    - `mathBlockMask` for the incremental parser's safe-split search
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  inlineToText,
  mathBlockMask,
  parseInline,
  parseMarkdown,
  type MdInline,
  type MdNode,
} from '../markdownRenderer.js'

const text = (s: string): MdInline => ({ type: 'text', text: s })
const math = (tex: string, display = false): MdInline => ({ type: 'math_inline', tex, display })

describe('parseMarkdown — block math', () => {
  it('parses a single-line $$…$$ block', () => {
    expect(parseMarkdown('$$x$$')).toEqual<readonly MdNode[]>([
      { type: 'math_block', tex: 'x', display: true, line: 0 },
    ])
  })

  it('trims the TeX inside a single-line block', () => {
    expect(parseMarkdown('$$ x + y $$')).toEqual<readonly MdNode[]>([
      { type: 'math_block', tex: 'x + y', display: true, line: 0 },
    ])
  })

  it('allows up to three leading spaces', () => {
    expect(parseMarkdown('   $$x$$')).toEqual<readonly MdNode[]>([
      { type: 'math_block', tex: 'x', display: true, line: 0 },
    ])
  })

  it('does not open a block with four leading spaces', () => {
    const nodes = parseMarkdown('    $$x$$')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.type).toBe('paragraph')
  })

  it('parses a multi-line block and keeps blank lines inside the TeX', () => {
    expect(parseMarkdown('$$\nx + y\n\ny\n$$')).toEqual<readonly MdNode[]>([
      { type: 'math_block', tex: 'x + y\n\ny', display: true, line: 0 },
    ])
  })

  it('keeps content on the opening and closing lines', () => {
    expect(parseMarkdown('$$x +\ny$$\nz')).toEqual<readonly MdNode[]>([
      { type: 'math_block', tex: 'x +\ny', display: true, line: 0 },
      { type: 'paragraph', children: [text('z')], line: 2 },
    ])
  })

  it('runs an unterminated block to EOF', () => {
    expect(parseMarkdown('$$\nx + y')).toEqual<readonly MdNode[]>([
      { type: 'math_block', tex: 'x + y', display: true, line: 0 },
    ])
  })

  it('discards text after the closing $$ on the same line', () => {
    expect(parseMarkdown('$$\nx $$ trailing\nafter')).toEqual<readonly MdNode[]>([
      { type: 'math_block', tex: 'x', display: true, line: 0 },
      { type: 'paragraph', children: [text('after')], line: 2 },
    ])
  })

  it('reports the absolute source line', () => {
    expect(parseMarkdown('intro\n\n$$x$$')).toEqual<readonly MdNode[]>([
      { type: 'paragraph', children: [text('intro')], line: 0 },
      { type: 'math_block', tex: 'x', display: true, line: 2 },
    ])
  })

  it('breaks a paragraph when a block starts on the next line', () => {
    expect(parseMarkdown('intro\n$$x$$')).toEqual<readonly MdNode[]>([
      { type: 'paragraph', children: [text('intro')], line: 0 },
      { type: 'math_block', tex: 'x', display: true, line: 1 },
    ])
  })

  it.each(['$$$', '$$$$', '$$$x$$$'])('does not treat %s as a block opener', (md) => {
    const nodes = parseMarkdown(md)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.type).toBe('paragraph')
  })

  it('leaves a line with two $$ pairs to the inline rules', () => {
    expect(parseMarkdown('$$a$$ $$b$$')).toEqual<readonly MdNode[]>([
      {
        type: 'paragraph',
        children: [math('a', true), text(' '), math('b', true)],
        line: 0,
      },
    ])
  })

  it('does not open a block inside a code fence', () => {
    expect(parseMarkdown('```\n$$\nx\n```')).toEqual<readonly MdNode[]>([
      { type: 'code_fence', lang: '', code: '$$\nx', line: 0 },
    ])
  })

  it('treats fences inside a block as TeX', () => {
    expect(parseMarkdown('$$\n```\nx\n```\n$$')).toEqual<readonly MdNode[]>([
      { type: 'math_block', tex: '```\nx\n```', display: true, line: 0 },
    ])
  })

  it('parses a block inside a blockquote with an absolute line', () => {
    expect(parseMarkdown('> $$\n> x\n> $$')).toEqual<readonly MdNode[]>([
      {
        type: 'blockquote',
        children: [{ type: 'math_block', tex: 'x', display: true, line: 0 }],
        line: 0,
      },
    ])
  })

  it('parses a block opened on a list item line', () => {
    expect(parseMarkdown('- $$\n  x +\n  y\n  $$')).toEqual<readonly MdNode[]>([
      {
        type: 'list',
        ordered: false,
        items: [
          {
            inline: [],
            checked: null,
            children: [{ type: 'math_block', tex: 'x +\ny', display: true, line: 0 }],
          },
        ],
        line: 0,
      },
    ])
  })

  it('keeps - $$x$$ as inline display math on the item', () => {
    expect(parseMarkdown('- $$x$$')).toEqual<readonly MdNode[]>([
      {
        type: 'list',
        ordered: false,
        items: [{ inline: [math('x', true)], checked: null }],
        line: 0,
      },
    ])
  })

  it('parses a block nested under an indented list item with an absolute line', () => {
    const nodes = parseMarkdown('- item\n  $$\n  x\n  $$')
    const list = nodes[0]!
    expect(list.type).toBe('list')
    const item = list.type === 'list' ? list.items[0]! : undefined
    expect(item?.inline).toEqual([text('item')])
    expect(item?.children).toEqual([{ type: 'math_block', tex: 'x', display: true, line: 1 }])
  })

  it('disables block parsing with math: false', () => {
    const nodes = parseMarkdown('$$\nx\n$$', { math: false })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.type).toBe('paragraph')
  })

  it('propagates math: false into nested blocks', () => {
    const nodes = parseMarkdown('- item\n  $$\n  x\n  $$', { math: false })
    expect(JSON.stringify(nodes)).not.toContain('math_block')
    expect(JSON.stringify(nodes)).not.toContain('math_inline')
  })
})

describe('parseInline — inline math', () => {
  it('parses $…$', () => {
    expect(parseInline('$x$')).toEqual([math('x')])
  })

  it('parses math inside surrounding text', () => {
    expect(parseInline('a $x$ b')).toEqual([text('a '), math('x'), text(' b')])
  })

  it('parses two formulas on one line', () => {
    expect(parseInline('$x$ and $y$')).toEqual([math('x'), text(' and '), math('y')])
  })

  it('parses mid-paragraph $$…$$ as display math', () => {
    expect(parseInline('a $$x$$ b')).toEqual([text('a '), math('x', true), text(' b')])
  })

  it('keeps money-like dollars as text', () => {
    expect(parseInline('$5 and $6')).toEqual([text('$5 and $6')])
  })

  it('rejects a closer followed by a word character', () => {
    expect(parseInline('$x$5')).toEqual([text('$x$5')])
  })

  it('rejects an opener preceded by a word character', () => {
    expect(parseInline('abc$x$')).toEqual([text('abc$x$')])
  })

  it('gives up on the first invalid closer instead of stretching to the last $', () => {
    expect(parseInline('$a$b$c$')).toEqual([text('$a$b$c$')])
  })

  it('gives up on the first invalid display candidate', () => {
    // markdown-it-katex checks only the first unescaped `$$`; its `$`-run
    // boundary is invalid, so the whole thing stays literal.
    expect(parseInline('$$a$$$ b$$')).toEqual([text('$$a$$$ b$$')])
  })

  it('allows CJK text next to the delimiters', () => {
    expect(parseInline('中文$x$中文')).toEqual([text('中文'), math('x'), text('中文')])
  })

  it('does not parse a dollar escaped on the opening side', () => {
    expect(parseInline('\\$x$')).toEqual([text('$x$')])
  })

  it('skips escaped dollars when looking for the closer', () => {
    expect(parseInline('$a \\$ b$')).toEqual([math('a \\$ b')])
  })

  it('leaves an unclosed $ as text', () => {
    expect(parseInline('cost $5')).toEqual([text('cost $5')])
  })

  it('allows a formula to span a soft line break', () => {
    expect(parseInline('$a\nb$')).toEqual([math('a\nb')])
  })

  it('does not treat $$$ as math', () => {
    expect(parseInline('$$$')).toEqual([text('$$$')])
    expect(parseInline('$$$$')).toEqual([text('$$$$')])
  })

  it('keeps markdown syntax inside TeX verbatim', () => {
    expect(parseInline('$a * b_ c$')).toEqual([math('a * b_ c')])
  })

  it('gives code spans priority over math', () => {
    expect(parseInline('`$x$`')).toEqual([{ type: 'code', text: '$x$' }])
    expect(parseInline('`code` $x$')).toEqual([
      { type: 'code', text: 'code' },
      text(' '),
      math('x'),
    ])
  })

  it('parses math inside a link label', () => {
    expect(parseInline('[$x$](https://example.com)')).toEqual([
      {
        type: 'link',
        href: 'https://example.com',
        children: [math('x')],
      },
    ])
  })

  it('disables inline parsing with math: false', () => {
    expect(parseInline('$x$', { math: false })).toEqual([text('$x$')])
    expect(parseInline('a $$x$$ b', { math: false })).toEqual([text('a $$x$$ b')])
  })

  it('still unescapes \\$ with math: false', () => {
    expect(parseInline('\\$5', { math: false })).toEqual([text('$5')])
  })
})

describe('math in other blocks', () => {
  it('parses math in a heading', () => {
    expect(parseMarkdown('## $x^2$')).toEqual<readonly MdNode[]>([
      { type: 'heading', level: 2, children: [math('x^2')], line: 0 },
    ])
  })

  it('parses math in a table cell', () => {
    expect(parseMarkdown('| $x$ | b |\n| --- | --- |')).toEqual<readonly MdNode[]>([
      {
        type: 'table',
        align: [null, null],
        header: [[math('x')], [text('b')]],
        rows: [],
        line: 0,
      },
    ])
  })

  it('exposes the raw TeX through inlineToText', () => {
    expect(inlineToText(parseInline('a $x$ b'))).toBe('a x b')
    expect(inlineToText(parseInline('a $$x$$ b'))).toBe('a x b')
  })
})

describe('mathBlockMask', () => {
  it('marks multi-line math and leaves single-line math alone', () => {
    const lines = ['$$', 'x', '', '$$', '', '$$y$$', 'tail']
    const mask = mathBlockMask(lines)
    expect(mask.insideMath).toEqual([true, true, true, true, false, false, false])
    expect(mask.insideFence).toEqual([false, false, false, false, false, false, false])
  })

  it('marks an unterminated block through EOF, including blank lines', () => {
    const mask = mathBlockMask(['$$', 'x', '', ''])
    expect(mask.insideMath).toEqual([true, true, true, true])
  })

  it('lets math win over fences inside a block', () => {
    const mask = mathBlockMask(['$$', '```', 'x', '```', '$$'])
    expect(mask.insideMath).toEqual([true, true, true, true, true])
    expect(mask.insideFence).toEqual([false, false, false, false, false])
  })

  it('lets fences win over $$ inside code', () => {
    const mask = mathBlockMask(['```', '$$', 'x', '$$', '```', '$$y$$'])
    expect(mask.insideMath).toEqual([false, false, false, false, false, false])
    expect(mask.insideFence).toEqual([false, true, true, true, true, false])
  })

  it('marks a multi-line block opened on a list item line', () => {
    const lines = ['- $$', '  x', '', '  y', '  $$', '', 'after']
    const mask = mathBlockMask(lines)
    expect(mask.insideMath).toEqual([true, true, true, true, true, false, false])
  })

  it('recognizes ordered and task list item openers', () => {
    expect(mathBlockMask(['1. $$', '   x', '']).insideMath).toEqual([true, true, true])
    expect(mathBlockMask(['- [ ] $$', '      x', '']).insideMath).toEqual([true, true, true])
  })

  it('does not mark single-line math on a list item line', () => {
    const mask = mathBlockMask(['- $$x$$', '', 'tail'])
    expect(mask.insideMath).toEqual([false, false, false])
  })

  it('does not let a dedented $$ close list-item math', () => {
    // The parser's list item ends at the dedented line; that line opens a new
    // top-level formula instead of closing the item's child math. The scan
    // restarts there, so the blank ending the item is a real boundary.
    const mask = mathBlockMask(['- $$', '  x', '', '$$', 'y', '', 'z'])
    expect(mask.insideMath).toEqual([true, true, false, true, true, true, true])
  })

  it('keeps an indented list-child formula scoped to its item', () => {
    const mask = mathBlockMask([
      '- 公式：',
      '  $$',
      '  E = mc^2',
      '',
      '说明文字',
      '',
      '$$',
      'a = b',
      '',
    ])
    expect(mask.insideMath.slice(0, 1)).toEqual([false])
    expect(mask.insideMath.slice(1).every(Boolean)).toBe(true)
  })

  it('treats dedented content after an indented opener as uncertain', () => {
    const mask = mathBlockMask(['- item', '  $$', '  x', '', 'outside', '', '  $$', 'y', '', 'z'])
    expect(mask.insideMath.slice(0, 1)).toEqual([false])
    expect(mask.insideMath.slice(1).every(Boolean)).toBe(true)
  })

  it('ignores math when the parser runs with math: false', () => {
    expect(mathBlockMask(['$$', 'x', '', ''], false).insideMath).toEqual([
      false,
      false,
      false,
      false,
    ])
    const fenced = mathBlockMask(['```', '$$', '', 'x', '```', ''], false)
    expect(fenced.insideMath).toEqual([false, false, false, false, false, false])
    expect(fenced.insideFence).toEqual([false, true, true, true, true, false])
  })
})
