/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bounds and identity guarantees of the non-streaming markdown parse cache. A cache that
 *  returns a deep-equal copy instead of the same array still renders, so identity is the
 *  assertion that separates "reused the AST" from "parsed it again".
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  MARKDOWN_PARSE_BYTES_PER_CHAR,
  MARKDOWN_PARSE_MIN_CHARS,
  MarkdownParseCache,
  markdownParseCacheStats,
  parseMarkdownCached,
  releaseMarkdownParseCache,
} from '../markdownParseCache.js'
import type { MdNode } from '../markdownRenderer.js'

function hasNode(nodes: readonly MdNode[], type: MdNode['type']): boolean {
  return nodes.some((node) => node.type === type)
}

describe('MarkdownParseCache — identity', () => {
  it('returns the same AST array for the same text and options', () => {
    const cache = new MarkdownParseCache({ minChars: 0 })
    const first = cache.parse('hello **world**')
    expect(cache.parse('hello **world**')).toBe(first)
  })

  it('keys on parse options, not just the text', () => {
    const cache = new MarkdownParseCache({ minChars: 0 })
    const text = 'the formula $x$'

    const math = cache.parse(text)
    const literal = cache.parse(text, { math: false })

    expect(literal).not.toBe(math)
    expect(hasNode(math, 'paragraph')).toBe(true)
    expect(JSON.stringify(math)).toContain('math_inline')
    expect(JSON.stringify(literal)).not.toContain('math_inline')

    expect(cache.parse(text)).toBe(math)
    expect(cache.parse(text, { math: false })).toBe(literal)
    expect(cache.stats()).toMatchObject({ entries: 1, chars: text.length * 2 })
  })

  it('distinguishes frontmatter handling', () => {
    const cache = new MarkdownParseCache({ minChars: 0 })
    const text = '---\ntitle: hi\n---\n\n# Body'

    const plain = cache.parse(text)
    const frontmatter = cache.parse(text, { frontmatter: true })

    expect(frontmatter).not.toBe(plain)
    expect(hasNode(plain, 'frontmatter')).toBe(false)
    expect(hasNode(frontmatter, 'frontmatter')).toBe(true)
  })
})

describe('MarkdownParseCache — bounds', () => {
  it('does not cache short inputs', () => {
    const cache = new MarkdownParseCache({ minChars: 8 })
    const first = cache.parse('short')
    expect(cache.parse('short')).not.toBe(first)
    expect(cache.stats().entries).toBe(0)
  })

  it('does not cache a single input larger than the character budget', () => {
    const cache = new MarkdownParseCache({ minChars: 0, maxChars: 8 })
    const first = cache.parse('123456789')
    expect(cache.parse('123456789')).not.toBe(first)
    expect(cache.stats()).toMatchObject({ entries: 0, chars: 0 })
  })

  it('evicts the least recently used entry by count', () => {
    const cache = new MarkdownParseCache({ minChars: 0, maxEntries: 2 })
    const a = cache.parse('A')
    const b = cache.parse('B')
    cache.parse('C')

    expect(cache.stats().entries).toBe(2)
    expect(cache.parse('B')).toBe(b)
    expect(cache.parse('A')).not.toBe(a)
  })

  it('a hit refreshes the entry’s eviction order', () => {
    const cache = new MarkdownParseCache({ minChars: 0, maxEntries: 2 })
    const a = cache.parse('A')
    const b = cache.parse('B')
    cache.parse('A')
    cache.parse('C')

    expect(cache.parse('A')).toBe(a)
    expect(cache.parse('B')).not.toBe(b)
  })

  it('evicts by accumulated characters', () => {
    const cache = new MarkdownParseCache({ minChars: 0, maxEntries: 100, maxChars: 10 })
    const first = cache.parse('aaaaaa')
    cache.parse('bbbbbb')

    expect(cache.stats()).toMatchObject({ entries: 1, chars: 6 })
    expect(cache.parse('aaaaaa')).not.toBe(first)
  })

  it('drops a second option set that does not fit rather than exceeding the budget', () => {
    const cache = new MarkdownParseCache({ minChars: 0, maxEntries: 100, maxChars: 10 })
    const text = 'aaaaaa'
    cache.parse(text)
    const literal = cache.parse(text, { math: false })

    // Both variants of the same text count against the character budget (2 × 6 > 10).
    expect(cache.stats()).toMatchObject({ entries: 1, chars: 6 })
    expect(cache.parse(text, { math: false })).not.toBe(literal)
  })

  it('clear drops everything and reports the characters released', () => {
    const cache = new MarkdownParseCache({ minChars: 0 })
    const first = cache.parse('aaaa')
    expect(cache.stats()).toMatchObject({
      entries: 1,
      chars: 4,
      bytes: 4 * MARKDOWN_PARSE_BYTES_PER_CHAR,
    })

    expect(cache.clear()).toBe(4)
    expect(cache.stats()).toMatchObject({ entries: 0, chars: 0, bytes: 0 })
    expect(cache.parse('aaaa')).not.toBe(first)
  })
})

describe('module-level markdown parse cache', () => {
  afterEach(() => {
    releaseMarkdownParseCache()
  })

  it('caches at or above the minimum length', () => {
    const text = 'x'.repeat(MARKDOWN_PARSE_MIN_CHARS)
    const first = parseMarkdownCached(text)
    expect(parseMarkdownCached(text)).toBe(first)
    expect(markdownParseCacheStats().entries).toBe(1)
  })

  it('releases cached bytes for the memory pressure service', () => {
    const text = 'y'.repeat(MARKDOWN_PARSE_MIN_CHARS)
    parseMarkdownCached(text)

    expect(releaseMarkdownParseCache()).toBe(
      MARKDOWN_PARSE_MIN_CHARS * MARKDOWN_PARSE_BYTES_PER_CHAR,
    )
    expect(markdownParseCacheStats()).toMatchObject({ entries: 0, chars: 0, bytes: 0 })
  })
})
