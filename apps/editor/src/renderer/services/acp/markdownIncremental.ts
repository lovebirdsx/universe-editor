/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Incremental markdown parsing for streaming agent messages. A streaming
 *  message grows by one chunk at a time; re-parsing the whole accumulated text
 *  on every chunk is O(length²) for long messages and shows up as visible lag in
 *  the back half of a long stream.
 *
 *  Strategy: split the accumulated text at *safe* block boundaries — blank lines
 *  that are outside any code fence and do not sit inside a loose list (the only
 *  block that merges across blank lines, see `parseMarkdown`). Everything up to
 *  the last safe boundary is "sealed": parsed once, cached, and reused verbatim.
 *  Only the unsealed tail is re-parsed per chunk. As tail content seals it is
 *  appended to the cache incrementally, so each block is parsed exactly once and
 *  the amortized cost across the whole stream is O(length).
 *
 *  The output is byte-for-byte identical to `parseMarkdown(fullText)` (including
 *  block `line` numbers), so callers can swap it in transparently.
 *--------------------------------------------------------------------------------------------*/

import { parseMarkdown, type MdNode } from './markdownRenderer.js'

/**
 * Per-message incremental parse cache. Hold one of these in a ref across renders
 * of a single streaming message; reset it (or pass a fresh one) when the message
 * identity changes.
 */
export interface MarkdownStreamCache {
  /** Sealed prefix text, always ending at a safe block boundary. */
  sealedText: string
  /** Parsed nodes for `sealedText`, with global (final) `line` numbers. */
  sealedNodes: readonly MdNode[]
  /** Number of source lines (`\n` count) in `sealedText` — the line offset for the tail. */
  sealedLineCount: number
}

export function createMarkdownStreamCache(): MarkdownStreamCache {
  return { sealedText: '', sealedNodes: [], sealedLineCount: 0 }
}

/**
 * Parse `text` incrementally, mutating `cache` in place. Returns nodes identical
 * to `parseMarkdown(text)`. `parse` is injectable so tests can count how often
 * the underlying parser actually runs.
 */
export function parseMarkdownStreaming(
  text: string,
  cache: MarkdownStreamCache,
  parse: (input: string) => readonly MdNode[] = parseMarkdown,
): readonly MdNode[] {
  const splitPos = lastSafeSplit(text)
  const head = text.slice(0, splitPos)

  if (head === cache.sealedText) {
    // Sealed prefix unchanged — only the tail moved.
  } else if (cache.sealedText.length > 0 && head.startsWith(cache.sealedText)) {
    // The prefix grew: seal the newly-stable segment, parsing only it.
    const newSegment = head.slice(cache.sealedText.length)
    const segmentNodes = offsetLines(parse(newSegment), cache.sealedLineCount)
    cache.sealedNodes = [...cache.sealedNodes, ...segmentNodes]
    cache.sealedText = head
    cache.sealedLineCount += countLines(newSegment)
  } else {
    // First call, or the text diverged from the cached prefix (message reset /
    // non-monotonic input): re-seal from scratch. Head nodes are already global.
    cache.sealedNodes = parse(head)
    cache.sealedText = head
    cache.sealedLineCount = countLines(head)
  }

  if (splitPos >= text.length) return cache.sealedNodes
  const tail = text.slice(splitPos)
  const tailNodes = offsetLines(parse(tail), cache.sealedLineCount)
  return [...cache.sealedNodes, ...tailNodes]
}

/** Count newline characters — equals the source line offset for following text. */
function countLines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** Shift every block node's `line` by `delta`, preserving node shape. */
function offsetLines(nodes: readonly MdNode[], delta: number): readonly MdNode[] {
  if (delta === 0) return nodes
  return nodes.map((node) =>
    node.line !== undefined ? { ...node, line: node.line + delta } : node,
  )
}

/**
 * Return the character offset of the last *safe* split point in `text`, i.e. the
 * position just after a blank line at which `parse(head) ++ shift(parse(tail))`
 * equals `parse(text)`. A blank line is safe when it is outside any code fence
 * and is not the interior blank of a loose list, including list items that have
 * plain continuation lines. Returns 0 when no safe split exists.
 *
 * Splitting just after a blank line is sound because `parseMarkdown` skips
 * leading/trailing blank lines between blocks; the only cross-blank merge is the
 * loose-list case, which we explicitly exclude.
 */
function lastSafeSplit(text: string): number {
  const lines = text.split('\n')
  // Per-line starting char offsets so we can map a line index back to a cut.
  const lineStart: number[] = new Array(lines.length)
  let acc = 0
  for (let i = 0; i < lines.length; i++) {
    lineStart[i] = acc
    acc += (lines[i] ?? '').length + 1 // +1 for the '\n'
  }

  // Fence state per line: whether the line sits inside an open code fence.
  const insideFence: boolean[] = new Array(lines.length)
  let fenceOpen = false
  for (let i = 0; i < lines.length; i++) {
    insideFence[i] = fenceOpen
    if (/^```/.test(lines[i] ?? '')) fenceOpen = !fenceOpen
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim() !== '') continue
    if (insideFence[i]) continue
    if (isLooseListBlank(lines, i)) continue
    // Cut just after this blank line's newline. lineStart[i+1] is exactly that.
    const next = i + 1
    if (next >= lines.length) {
      // Trailing blank line(s) at EOF — cut after this line's newline.
      return Math.min((lineStart[i] ?? 0) + (lines[i] ?? '').length + 1, text.length)
    }
    return lineStart[next] ?? 0
  }
  return 0
}

type ListKind = 'ordered' | 'unordered'

/**
 * A blank line is "inside a loose list" when the nearest non-blank line before
 * it belongs to an open list item and the nearest non-blank line after it starts
 * the same kind of list — `parseMarkdown` would merge them into a single list
 * across the blank, so cutting here would split one list into two.
 */
function isLooseListBlank(lines: readonly string[], blankIdx: number): boolean {
  let prev = blankIdx - 1
  while (prev >= 0 && (lines[prev] ?? '').trim() === '') prev--
  let next = blankIdx + 1
  while (next < lines.length && (lines[next] ?? '').trim() === '') next++
  if (prev < 0 || next >= lines.length) return false
  const nextKind = listItemKind(lines[next] ?? '')
  if (!nextKind) return false
  for (let i = prev; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (line.trim() === '') return false
    const kind = listItemKind(line)
    if (kind) return kind === nextKind
    if (isTopLevelBlockStart(line, lines[i + 1] ?? '')) return false
  }
  return false
}

function listItemKind(line: string): ListKind | null {
  if (/^\s*\d+\.\s+/.test(line)) return 'ordered'
  if (/^\s*[-*+]\s+/.test(line)) return 'unordered'
  return null
}

function isTopLevelBlockStart(line: string, nextLine: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    isTableDelimiterRow(line) ||
    (line.includes('|') && isTableDelimiterRow(nextLine))
  )
}

const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function isTableDelimiterRow(line: string): boolean {
  return line.includes('-') && TABLE_DELIMITER_RE.test(line)
}
