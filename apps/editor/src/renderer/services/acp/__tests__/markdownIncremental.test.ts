/*---------------------------------------------------------------------------------------------
 *  Tests for incremental streaming markdown parsing. The contract is twofold:
 *    1. Equivalence — incremental output is deep-equal to parseMarkdown(full).
 *    2. Incrementality — each block is parsed at most once across a stream, so
 *       the underlying parser runs O(blocks) total, not O(chunks × blocks).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { drainHeapFlow } from '../../memory/heapFlowCounters.js'
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

describe('parseMarkdownStreaming — equivalence with parseMarkdown', () => {
  const cases: Record<string, string> = {
    empty: '',
    'single paragraph': 'hello world',
    'two paragraphs': 'first para\n\nsecond para',
    heading: '# Title\n\nbody text',
    'code fence with blank lines inside':
      'before\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter',
    'tight list': '- one\n- two\n- three',
    'loose list': '- one\n\n- two\n\n- three',
    'loose ordered list with continuation lines': '1. one\ncontinued\n\n2. two\ncontinued',
    'nested sublist blank-separated': '1. 子项1\n   - a\n   - b\n\n2. 子项2',
    'nested sublist tight': '1. 子项1\n   - a\n   - b\n2. 子项2',
    'ordered sublist in unordered item': '- top\n  1. x\n  2. y\n- top2',
    'three levels deep': '- a\n  - b\n    - c',
    'indented code fence in item': '- item\n  ```ts\n  const x = 1\n  ```\n- next',
    'second paragraph in item': '- p1\n\n  p2\n- next',
    table: '| a | b |\n| --- | --- |\n| 1 | 2 |\n\ntrailing',
    blockquote: '> quoted\n> more\n\nplain',
    'blockquote with sections': '> intro\n>\n> - a\n> - b\n\ntrailing',
    'mixed blocks': '# H1\n\npara one\n\n```js\nx()\n```\n\n- a\n- b\n\n> note\n\nfinal para',
    'trailing blanks': 'para\n\n\n',
    'leading blanks': '\n\npara',
    'unterminated fence': 'text\n\n```ts\nconst a = 1',
    'empty html anchor':
      'bold **CookSystem** fields <a id="tbl-cook"></a>\n\n| a |\n| --- |\n| 1 |',
    // Safe split point (blank after a sealed block) followed by a nested
    // structure in the tail: the nested blocks' absolute lines must be shifted
    // by the tail offset too, not just the tail's top-level blocks.
    'nested sublist after sealed paragraph': 'para\n\n- a\n  - b\n\n- c',
    'nested sublist after sealed blockquote': 'intro\n\n> q\n> r\n\n- item\n  - child',
    // The blockquote branch of offsetLines: a blockquote (with children) landing
    // in the tail must have its children's lines shifted by the tail offset.
    'blockquote after sealed paragraph': 'para\n\n> q\n> r',
    'blockquote with list after sealed paragraph': 'para\n\n> intro\n>\n> - a',
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
})

describe('parseMarkdownStreaming — line numbers', () => {
  it('preserves global line offsets after sealing', () => {
    const input = 'para one\n\npara two\n\npara three'
    const cache = createMarkdownStreamCache()
    const result = parseMarkdownStreaming(input, cache)
    expect(result.map((n) => (n as { line?: number }).line)).toEqual([0, 2, 4])
  })

  it('shifts nested block lines by the tail offset, not just top-level blocks', () => {
    // 'para' seals at the blank after it; the tail list (with a nested sublist)
    // is parsed separately and must have BOTH its own line and the nested
    // sublist's line shifted to absolute source lines (2 and 3).
    const input = 'para\n\n- a\n  - b'
    const cache = createMarkdownStreamCache()
    const result = parseMarkdownStreaming(input, cache)
    const list = result[1]!
    if (list.type !== 'list') throw new Error('expected list')
    expect(list.line).toBe(2)
    expect(list.items[0]?.children?.[0]).toMatchObject({ type: 'list', line: 3 })
  })
})

describe('parseMarkdownStreaming — incrementality', () => {
  it('parses each sealed block at most once across a char-by-char stream', () => {
    // Five paragraphs separated by blank lines → four safe split points.
    const final = 'aaaa\n\nbbbb\n\ncccc\n\ndddd\n\neeee'
    const parse = vi.fn(parseMarkdown)
    const cache = createMarkdownStreamCache()
    for (let i = 1; i <= final.length; i++) {
      parseMarkdownStreaming(final.slice(0, i), cache, parse)
    }

    // Naive re-parse would feed the whole accumulated text every char: the total
    // characters parsed would be ~O(n²). Incrementally, each char belongs to the
    // tail only until its block seals, so total parsed chars stays ~O(n).
    const totalCharsParsed = parse.mock.calls.reduce((sum, [s]) => sum + s.length, 0)
    expect(totalCharsParsed).toBeLessThan(final.length * 3)
  })

  it('does not re-parse the sealed prefix when only the tail grows', () => {
    const cache = createMarkdownStreamCache()
    // Seal two paragraphs.
    parseMarkdownStreaming('alpha\n\nbeta\n\n', cache)
    const sealedAfter = cache.sealedText

    const parse = vi.fn(parseMarkdown)
    parseMarkdownStreaming('alpha\n\nbeta\n\ngamm', cache, parse)
    // Only the tail ('gamm') should be parsed, never the sealed prefix.
    expect(parse).toHaveBeenCalledTimes(1)
    expect(parse).toHaveBeenCalledWith('gamm')
    expect(cache.sealedText).toBe(sealedAfter)
  })
})

describe('parseMarkdownStreaming — reset / non-monotonic input', () => {
  it('re-seals from scratch when the text diverges from the cached prefix', () => {
    const cache = createMarkdownStreamCache()
    parseMarkdownStreaming('first\n\nsecond\n\ntail', cache)
    // A completely different message reuses the same cache (e.g. message reset).
    const replaced = 'brand\n\nnew\n\ncontent'
    expect(parseMarkdownStreaming(replaced, cache)).toEqual(parseMarkdown(replaced))
  })
})

describe('parseMarkdownStreaming — sealed prefix identity', () => {
  // MarkdownView hands the sealed half to a memoized component and relies on those
  // nodes keeping their identity across chunks — that is the whole reason a growing
  // tail can skip reconciliation. Both halves of the premise are asserted here: the
  // result heads with the cache's own elements, and sealing only ever appends.
  it('keeps sealed elements identical across a char-by-char stream', () => {
    const final = 'aaaa\n\nbbbb\n\ncccc\n\ndddd\n\neeee'
    const cache = createMarkdownStreamCache()
    let previouslySealed: readonly MdNode[] = []

    for (let i = 1; i <= final.length; i++) {
      const nodes = parseMarkdownStreaming(final.slice(0, i), cache)
      const sealed = cache.sealedNodes
      expect(nodes.slice(0, sealed.length)).toHaveLength(sealed.length)
      for (let k = 0; k < sealed.length; k++) {
        expect(Object.is(nodes[k], sealed[k])).toBe(true)
        if (k < previouslySealed.length)
          expect(Object.is(sealed[k], previouslySealed[k])).toBe(true)
      }
      previouslySealed = sealed
    }

    // A stream that sealed nothing would make every assertion above vacuous.
    expect(previouslySealed.length).toBeGreaterThan(1)
    expect(parseMarkdownStreaming(final, cache)).toEqual(parseMarkdown(final))
  })
})

describe('parseMarkdownStreaming — flow accounting', () => {
  // `mdparse.chars` is what the streaming e2e spec bounds work by, so its unit has to
  // be the characters actually re-parsed: counting `text.length` per call would make
  // the bound scale with (renders × length) no matter how well sealing works, and the
  // spec would pass on an implementation that re-parses everything.
  it('counts the characters it re-parses, not the whole message', () => {
    drainHeapFlow()
    const paragraphs = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
    const cache = createMarkdownStreamCache()
    for (let i = 1; i <= paragraphs.length; i++) {
      parseMarkdownStreaming(paragraphs.slice(0, i).join('\n\n'), cache)
    }

    const mdparse = drainHeapFlow().find((f) => f.name === 'mdparse')
    const finalLength = paragraphs.join('\n\n').length
    expect(mdparse?.calls).toBe(paragraphs.length)
    // Each call re-parses its new paragraph plus the (tiny) unsealed tail. Charging
    // `text.length` instead would cost the growing prefix again every call — 72 here
    // against a bound of 66.
    expect(mdparse?.chars).toBeLessThan(3 * finalLength)
  })
})
