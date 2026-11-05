/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bounded, process-wide cache for non-streaming `parseMarkdown` results.
 *
 *  Switching chat tabs remounts the whole timeline, and every settled message re-parsed
 *  its text on the first render after the remount. The streaming path already seals
 *  finished blocks; settled messages had nothing, so a 100k-character session paid a
 *  full re-parse on every tab switch. The AST is a pure function of (text, options), and
 *  no consumer mutates it — every node field is `readonly` and renderers only map over
 *  the arrays — so the same array can be handed back verbatim.
 *
 *  Bounds are entry count + source characters: 200 entries / 2M characters is a small
 *  fraction of the 256MB live-ingestion budget (`session/cases-memory-budget.md`) and
 *  still covers far more than the ~100k characters a long session carries. Inputs below
 *  `MIN_CHARS` are parsed but not cached — parsing them is cheap and keeping them would
 *  only fill the LRU with noise.
 *--------------------------------------------------------------------------------------------*/

import { parseMarkdown, type MdNode, type ParseMarkdownOptions } from './markdownRenderer.js'

export interface MarkdownParseCacheStats {
  readonly entries: number
  /** Source characters counted against the budget (UTF-16 code units). */
  readonly chars: number
  /** Retained text in bytes; AST node objects are not included (a floor, not an estimate). */
  readonly bytes: number
}

export interface MarkdownParseCacheOptions {
  readonly maxEntries?: number
  readonly maxChars?: number
  /** Inputs shorter than this are parsed but not cached. */
  readonly minChars?: number
}

export const MARKDOWN_PARSE_MAX_ENTRIES = 200
export const MARKDOWN_PARSE_MAX_CHARS = 2_000_000
export const MARKDOWN_PARSE_MIN_CHARS = 512
/** UTF-16 bytes per cached source character. */
export const MARKDOWN_PARSE_BYTES_PER_CHAR = 2

interface CacheEntry {
  /** Option signature -> nodes parsed with that signature. */
  readonly variants: Map<string, readonly MdNode[]>
}

/**
 * Map iteration order is insertion order, so an entry is moved to the end on every hit
 * and the oldest key is the first one out. Entries are keyed by the source text itself:
 * the same string instance a settled message holds, so the key adds no copy of the body.
 */
export class MarkdownParseCache {
  private readonly _entries = new Map<string, CacheEntry>()
  private _chars = 0
  private readonly _maxEntries: number
  private readonly _maxChars: number
  private readonly _minChars: number

  constructor(options: MarkdownParseCacheOptions = {}) {
    this._maxEntries = options.maxEntries ?? MARKDOWN_PARSE_MAX_ENTRIES
    this._maxChars = options.maxChars ?? MARKDOWN_PARSE_MAX_CHARS
    this._minChars = options.minChars ?? MARKDOWN_PARSE_MIN_CHARS
  }

  /** Cached parse for external callers; `lineOffset` stays internal to `parseMarkdown`. */
  parse(input: string, options?: ParseMarkdownOptions): readonly MdNode[] {
    if (input.length < this._minChars || input.length > this._maxChars) {
      return parseMarkdown(input, options)
    }
    const optionKey = optionKeyOf(options)
    const entry = this._entries.get(input)
    const cached = entry?.variants.get(optionKey)
    if (entry !== undefined && cached !== undefined) {
      this._entries.delete(input)
      this._entries.set(input, entry)
      return cached
    }
    const nodes = parseMarkdown(input, options)
    this._store(input, optionKey, nodes)
    return nodes
  }

  stats(): MarkdownParseCacheStats {
    return {
      entries: this._entries.size,
      chars: this._chars,
      bytes: this._chars * MARKDOWN_PARSE_BYTES_PER_CHAR,
    }
  }

  /** Drop everything, returning the source characters released. */
  clear(): number {
    const freed = this._chars
    this._entries.clear()
    this._chars = 0
    return freed
  }

  private _store(input: string, optionKey: string, nodes: readonly MdNode[]): void {
    let entry = this._entries.get(input)
    if (entry === undefined) {
      entry = { variants: new Map() }
    } else {
      this._entries.delete(input)
    }
    this._entries.set(input, entry)
    entry.variants.set(optionKey, nodes)
    this._chars += input.length
    // Keep the entry that was just written; evict oldest-first for the rest.
    for (const key of [...this._entries.keys()]) {
      if (this._chars <= this._maxChars && this._entries.size <= this._maxEntries) break
      if (key === input) continue
      this._deleteEntry(key)
    }
    // A second option set on a text that already fills the budget cannot fit even with
    // every other entry gone; drop the new variant instead of holding an oversized entry.
    if (this._chars > this._maxChars || this._entries.size > this._maxEntries) {
      this._removeVariant(input, optionKey)
    }
  }

  private _deleteEntry(key: string): number {
    const entry = this._entries.get(key)
    if (entry === undefined) return 0
    this._entries.delete(key)
    const freed = key.length * entry.variants.size
    this._chars -= freed
    return freed
  }

  private _removeVariant(key: string, optionKey: string): void {
    const entry = this._entries.get(key)
    if (entry === undefined) return
    if (!entry.variants.delete(optionKey)) return
    this._chars -= key.length
    if (entry.variants.size === 0) this._entries.delete(key)
  }
}

/**
 * Option dimensions that change the AST. `math` and `frontmatter` are normalized to
 * their effective boolean (omitted = enabled / disabled), and the scheme list keeps its
 * exact values because the link predicate matches them case-sensitively.
 */
function optionKeyOf(options: ParseMarkdownOptions | undefined): string {
  const frontmatter = options?.frontmatter === true ? 1 : 0
  const math = options?.math === false ? 0 : 1
  const schemes = options?.extraHrefSchemes
  const schemesKey = schemes !== undefined && schemes.length > 0 ? JSON.stringify(schemes) : ''
  return `${frontmatter}:${math}:${schemesKey}`
}

const defaultCache = new MarkdownParseCache()

/**
 * Use this instead of `parseMarkdown` for static (non-streaming) consumers. The parser
 * remains the single source of truth for AST shape; this only memoizes its result.
 */
export function parseMarkdownCached(
  input: string,
  options?: ParseMarkdownOptions,
): readonly MdNode[] {
  return defaultCache.parse(input, options)
}

export function markdownParseCacheStats(): MarkdownParseCacheStats {
  return defaultCache.stats()
}

/** Drop the process-wide cache; returns the retained text bytes released. */
export function releaseMarkdownParseCache(): number {
  return defaultCache.clear() * MARKDOWN_PARSE_BYTES_PER_CHAR
}
