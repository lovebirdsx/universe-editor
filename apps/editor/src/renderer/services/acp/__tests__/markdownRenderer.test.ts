/*---------------------------------------------------------------------------------------------
 *  Tests for the markdown parser used to render agent output. Covers:
 *    - block-level shapes (paragraph, heading, code fence, list, blockquote, hr)
 *    - inline shapes (text, bold, italic, code, link, autolink, softbreak)
 *    - safety: no raw HTML, only allow-listed link schemes
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  isSafeHref,
  parseInline,
  parseMarkdown,
  type MdInline,
  type MdNode,
} from '../markdownRenderer.js'

const text = (s: string): MdInline => ({ type: 'text', text: s })

describe('parseMarkdown — block layer', () => {
  it('returns an empty array for empty input', () => {
    expect(parseMarkdown('')).toEqual([])
  })

  it('parses a single paragraph', () => {
    expect(parseMarkdown('hello world')).toEqual<readonly MdNode[]>([
      { type: 'paragraph', children: [text('hello world')], line: 0 },
    ])
  })

  it('treats consecutive non-blank lines as one paragraph with softbreaks', () => {
    expect(parseMarkdown('line one\nline two')).toEqual<readonly MdNode[]>([
      {
        type: 'paragraph',
        children: [text('line one'), { type: 'softbreak' }, text('line two')],
        line: 0,
      },
    ])
  })

  it('splits paragraphs at blank lines', () => {
    expect(parseMarkdown('p1\n\np2')).toEqual<readonly MdNode[]>([
      { type: 'paragraph', children: [text('p1')], line: 0 },
      { type: 'paragraph', children: [text('p2')], line: 2 },
    ])
  })

  it('parses headings 1-6', () => {
    const md = '# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6'
    const nodes = parseMarkdown(md)
    expect(nodes).toHaveLength(6)
    expect(nodes.map((n) => (n.type === 'heading' ? n.level : null))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('tolerates trailing hashes in an ATX heading', () => {
    expect(parseMarkdown('## title ##')).toEqual<readonly MdNode[]>([
      { type: 'heading', level: 2, children: [text('title')], line: 0 },
    ])
  })

  it('parses a fenced code block with a language', () => {
    expect(parseMarkdown('```ts\nconst x = 1\n```')).toEqual<readonly MdNode[]>([
      { type: 'code_fence', lang: 'ts', code: 'const x = 1', line: 0 },
    ])
  })

  it('parses a fenced code block without a language', () => {
    expect(parseMarkdown('```\nplain\ntext\n```')).toEqual<readonly MdNode[]>([
      { type: 'code_fence', lang: '', code: 'plain\ntext', line: 0 },
    ])
  })

  it('handles an unterminated code fence by closing it at EOF', () => {
    expect(parseMarkdown('```js\nstill open')).toEqual<readonly MdNode[]>([
      { type: 'code_fence', lang: 'js', code: 'still open', line: 0 },
    ])
  })

  it('parses unordered lists with -, *, +', () => {
    const md = '- one\n* two\n+ three'
    const nodes = parseMarkdown(md)
    expect(nodes).toHaveLength(1)
    const list = nodes[0]!
    expect(list.type).toBe('list')
    if (list.type === 'list') {
      expect(list.ordered).toBe(false)
      expect(list.items).toHaveLength(3)
    }
  })

  it('parses ordered lists', () => {
    expect(parseMarkdown('1. a\n2. b')).toEqual<readonly MdNode[]>([
      {
        type: 'list',
        ordered: true,
        items: [
          { inline: [text('a')], checked: null },
          { inline: [text('b')], checked: null },
        ],
        line: 0,
      },
    ])
  })

  it('keeps loose ordered lists as one list', () => {
    expect(parseMarkdown('1. a\n\n2. b\n\n3. c')).toEqual<readonly MdNode[]>([
      {
        type: 'list',
        ordered: true,
        items: [
          { inline: [text('a')], checked: null },
          { inline: [text('b')], checked: null },
          { inline: [text('c')], checked: null },
        ],
        line: 0,
      },
    ])
  })

  it('ends a list when a blank line is not followed by another list item', () => {
    const md = '- a\n- b\n\nparagraph'
    const nodes = parseMarkdown(md)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]?.type).toBe('list')
    expect(nodes[1]?.type).toBe('paragraph')
  })

  it('parses blockquotes', () => {
    expect(parseMarkdown('> quoted\n> more')).toEqual<readonly MdNode[]>([
      {
        type: 'blockquote',
        children: [text('quoted'), { type: 'softbreak' }, text('more')],
        line: 0,
      },
    ])
  })

  it('parses horizontal rules', () => {
    expect(parseMarkdown('---')).toEqual<readonly MdNode[]>([{ type: 'hr', line: 0 }])
    expect(parseMarkdown('***')).toEqual<readonly MdNode[]>([{ type: 'hr', line: 0 }])
    expect(parseMarkdown('___')).toEqual<readonly MdNode[]>([{ type: 'hr', line: 0 }])
  })

  it('normalizes CRLF and CR line endings', () => {
    expect(parseMarkdown('a\r\nb\rc')).toEqual<readonly MdNode[]>([
      {
        type: 'paragraph',
        children: [text('a'), { type: 'softbreak' }, text('b'), { type: 'softbreak' }, text('c')],
        line: 0,
      },
    ])
  })
})

describe('parseMarkdown — GFM tables', () => {
  it('parses a basic pipe table with header and data rows', () => {
    expect(parseMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')).toEqual<
      readonly MdNode[]
    >([
      {
        type: 'table',
        align: [null, null],
        header: [[text('A')], [text('B')]],
        rows: [
          [[text('1')], [text('2')]],
          [[text('3')], [text('4')]],
        ],
        line: 0,
      },
    ])
  })

  it('parses column alignment from the delimiter row', () => {
    const nodes = parseMarkdown('| L | C | R | D |\n| :-- | :-: | --: | --- |\n| a | b | c | d |')
    expect(nodes[0]?.type).toBe('table')
    expect(nodes[0]).toMatchObject({ align: ['left', 'center', 'right', null] })
  })

  it('parses inline syntax inside cells', () => {
    const nodes = parseMarkdown('| H |\n| --- |\n| **bold** |')
    expect(nodes[0]).toMatchObject({
      type: 'table',
      rows: [[[{ type: 'bold', children: [text('bold')] }]]],
    })
  })

  it('treats an escaped pipe as a literal cell character', () => {
    const nodes = parseMarkdown('| A | B |\n| --- | --- |\n| x \\| y | z |')
    expect(nodes[0]).toMatchObject({
      type: 'table',
      rows: [[[text('x | y')], [text('z')]]],
    })
  })

  it('normalizes ragged rows against the header column count', () => {
    const nodes = parseMarkdown('| A | B |\n| --- | --- |\n| only |\n| 1 | 2 | 3 |')
    expect(nodes[0]).toMatchObject({
      type: 'table',
      rows: [
        [[text('only')], []],
        [[text('1')], [text('2')]],
      ],
    })
  })

  it('ends the preceding paragraph when a table starts', () => {
    const nodes = parseMarkdown('intro text\n| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(nodes[0]).toEqual<MdNode>({ type: 'paragraph', children: [text('intro text')], line: 0 })
    expect(nodes[1]?.type).toBe('table')
  })

  it('does not treat pipe text without a delimiter row as a table', () => {
    expect(parseMarkdown('a | b | c')).toEqual<readonly MdNode[]>([
      { type: 'paragraph', children: [text('a | b | c')], line: 0 },
    ])
  })
})

describe('parseInline — inline layer', () => {
  it('returns plain text untouched', () => {
    expect(parseInline('hello')).toEqual<readonly MdInline[]>([text('hello')])
  })

  it('parses bold with ** and __', () => {
    expect(parseInline('a **b** c')).toEqual<readonly MdInline[]>([
      text('a '),
      { type: 'bold', children: [text('b')] },
      text(' c'),
    ])
    expect(parseInline('__b__')).toEqual<readonly MdInline[]>([
      { type: 'bold', children: [text('b')] },
    ])
  })

  it('parses italic with * and _', () => {
    expect(parseInline('*x*')).toEqual<readonly MdInline[]>([
      { type: 'italic', children: [text('x')] },
    ])
    expect(parseInline('_x_')).toEqual<readonly MdInline[]>([
      { type: 'italic', children: [text('x')] },
    ])
  })

  it('does not treat intraword underscores as emphasis (GFM rule)', () => {
    expect(parseInline('foo_bar_1')).toEqual<readonly MdInline[]>([text('foo_bar_1')])
    expect(parseInline('foo__bar__baz')).toEqual<readonly MdInline[]>([text('foo__bar__baz')])
    expect(parseInline('a_b_c_d')).toEqual<readonly MdInline[]>([text('a_b_c_d')])
  })

  it('still applies underscore emphasis at word boundaries', () => {
    expect(parseInline('an _italic_ word')).toEqual<readonly MdInline[]>([
      text('an '),
      { type: 'italic', children: [text('italic')] },
      text(' word'),
    ])
    expect(parseInline('a __bold__ word')).toEqual<readonly MdInline[]>([
      text('a '),
      { type: 'bold', children: [text('bold')] },
      text(' word'),
    ])
  })

  it('still applies intraword emphasis with asterisks', () => {
    expect(parseInline('foo*bar*baz')).toEqual<readonly MdInline[]>([
      text('foo'),
      { type: 'italic', children: [text('bar')] },
      text('baz'),
    ])
  })

  it('parses inline code, escaping special markdown inside', () => {
    expect(parseInline('see `**raw**` not bold')).toEqual<readonly MdInline[]>([
      text('see '),
      { type: 'code', text: '**raw**' },
      text(' not bold'),
    ])
  })

  it('parses links', () => {
    expect(parseInline('[Click](https://example.com)')).toEqual<readonly MdInline[]>([
      {
        type: 'link',
        href: 'https://example.com',
        children: [text('Click')],
      },
    ])
  })

  it('drops links with unsafe schemes (javascript:, data:)', () => {
    // Falls back to literal text so the user can still see what was attempted.
    const r = parseInline('[Bad](javascript:alert(1))')
    const hasLink = r.some((n) => n.type === 'link')
    expect(hasLink).toBe(false)
  })

  it('keeps explicit links with relative file-path hrefs', () => {
    expect(parseInline('[doc](../foo.md)')).toEqual<readonly MdInline[]>([
      { type: 'link', href: '../foo.md', children: [text('doc')] },
    ])
  })

  it('detects a bare file path with a dir separator and location', () => {
    expect(parseInline('see src/foo/bar.ts:10:5 now')).toEqual<readonly MdInline[]>([
      text('see '),
      { type: 'filepath', path: 'src/foo/bar.ts', line: 10, col: 5 },
      text(' now'),
    ])
  })

  it('does not treat a bare filename as a file path', () => {
    expect(parseInline('edit package.json please')).toEqual<readonly MdInline[]>([
      text('edit package.json please'),
    ])
  })

  it('parses autolinks <url> only for safe schemes', () => {
    expect(parseInline('see <https://example.com>')).toEqual<readonly MdInline[]>([
      text('see '),
      {
        type: 'link',
        href: 'https://example.com',
        children: [text('https://example.com')],
      },
    ])
    // Rejected scheme stays as plain text.
    const r = parseInline('see <javascript:1>')
    expect(r.some((n) => n.type === 'link')).toBe(false)
  })

  it('parses bare URLs', () => {
    expect(parseInline('visit https://example.com today')).toEqual<readonly MdInline[]>([
      text('visit '),
      {
        type: 'link',
        href: 'https://example.com',
        children: [text('https://example.com')],
      },
      text(' today'),
    ])
  })

  it('does not match URLs mid-word', () => {
    // `foohttps://x` — the leading `foo` makes this not look like a URL start.
    expect(parseInline('foohttps://x')).toEqual<readonly MdInline[]>([text('foohttps://x')])
  })

  it('honours backslash escapes', () => {
    expect(parseInline('\\*literal star\\*')).toEqual<readonly MdInline[]>([text('*literal star*')])
  })

  it('treats lone `*` (no closing partner) as literal text', () => {
    expect(parseInline('5 * 3 = 15')).toEqual<readonly MdInline[]>([text('5 * 3 = 15')])
  })

  it('nests bold inside italic and vice versa', () => {
    expect(parseInline('*a **b** c*')).toEqual<readonly MdInline[]>([
      {
        type: 'italic',
        children: [text('a '), { type: 'bold', children: [text('b')] }, text(' c')],
      },
    ])
  })

  it('softbreaks turn into break inlines', () => {
    expect(parseInline('a\nb')).toEqual<readonly MdInline[]>([
      text('a'),
      { type: 'softbreak' },
      text('b'),
    ])
  })
})

describe('isSafeHref', () => {
  it('accepts http/https/file', () => {
    expect(isSafeHref('http://x')).toBe(true)
    expect(isSafeHref('https://x')).toBe(true)
    expect(isSafeHref('file:///x')).toBe(true)
  })

  it('rejects javascript:, data:, vbscript:, and bare relative refs', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,...')).toBe(false)
    expect(isSafeHref('vbscript:...')).toBe(false)
    expect(isSafeHref('/relative')).toBe(false)
    expect(isSafeHref('./local')).toBe(false)
  })

  it('is case-insensitive on the scheme prefix', () => {
    expect(isSafeHref('HTTPS://x')).toBe(true)
    expect(isSafeHref('FILE:///x')).toBe(true)
  })
})
