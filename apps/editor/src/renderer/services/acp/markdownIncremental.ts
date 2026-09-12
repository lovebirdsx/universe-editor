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

import { bumpHeapFlow } from '../memory/heapFlowCounters.js'
import { codeFenceMask, parseMarkdown, type MdNode } from './markdownRenderer.js'

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
  // Characters handed to `parse` on this call — not `text.length`. Counting what is
  // actually re-parsed is what makes the counter answer the question it exists for:
  // a sealed prefix re-parses only the tail, so the total stays O(length) across a
  // whole stream, while a message that never seals re-parses all of itself on every
  // batch and shows up as (batches × length).
  let parsedChars = 0

  if (head === cache.sealedText) {
    // Sealed prefix unchanged — only the tail moved.
  } else if (cache.sealedText.length > 0 && head.startsWith(cache.sealedText)) {
    // The prefix grew: seal the newly-stable segment, parsing only it.
    const newSegment = head.slice(cache.sealedText.length)
    const segmentNodes = offsetLines(parse(newSegment), cache.sealedLineCount)
    parsedChars += newSegment.length
    cache.sealedNodes = [...cache.sealedNodes, ...segmentNodes]
    cache.sealedText = head
    cache.sealedLineCount += countLines(newSegment)
  } else {
    // First call, or the text diverged from the cached prefix (message reset /
    // non-monotonic input): re-seal from scratch. Head nodes are already global.
    // Counted apart from `mdparse`: a reseal count that tracks the parse count says
    // the split is finding no boundary to keep, i.e. this message never seals and
    // every chunk re-parses the whole thing.
    bumpHeapFlow('mdreseal', head.length)
    cache.sealedNodes = parse(head)
    parsedChars += head.length
    cache.sealedText = head
    cache.sealedLineCount = countLines(head)
  }

  let tailNodes: readonly MdNode[] | undefined
  if (splitPos < text.length) {
    const tail = text.slice(splitPos)
    tailNodes = offsetLines(parse(tail), cache.sealedLineCount)
    parsedChars += tail.length
  }
  bumpHeapFlow('mdparse', parsedChars)
  return tailNodes === undefined ? cache.sealedNodes : [...cache.sealedNodes, ...tailNodes]
}

/** Count newline characters — equals the source line offset for following text. */
function countLines(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * Shift every block node's `line` by `delta`, preserving node shape. Container
 * blocks (blockquote / list items) hold nested blocks whose `line` is absolute
 * within the text segment this parse saw, so the shift recurses into them —
 * shifting only the top level would leave nested blocks behind and break the
 * byte-for-byte equivalence with `parseMarkdown(fullText)`.
 */
function offsetLines(nodes: readonly MdNode[], delta: number): readonly MdNode[] {
  if (delta === 0) return nodes
  return nodes.map((node) => {
    const shifted = node.line !== undefined ? { ...node, line: node.line + delta } : node
    if (shifted.type === 'blockquote') {
      return { ...shifted, children: offsetLines(shifted.children, delta) }
    }
    if (shifted.type === 'list') {
      return {
        ...shifted,
        items: shifted.items.map((item) =>
          item.children ? { ...item, children: offsetLines(item.children, delta) } : item,
        ),
      }
    }
    return shifted
  })
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
  const insideFence = codeFenceMask(lines)

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
 * A blank line is "inside a loose list" when `parseMarkdown` would merge the
 * content across it into a single list — cutting there would wrongly split one
 * list into two. Two merge routes, scanning upward past the blank for an
 * enclosing list item:
 *   - child continuation: the line after the blank is indented into some
 *     (possibly ancestor) item's content column, so it's that item's child block.
 *   - loose sibling: the line after the blank is a same-indent, same-kind list
 *     item — the next sibling of the item above.
 *
 * Returning `true` too eagerly only costs a missed incremental split (never a
 * wrong render); the equivalence tests guard against the opposite — a real merge
 * point that slips through as `false`.
 */
function isLooseListBlank(lines: readonly string[], blankIdx: number): boolean {
  let next = blankIdx + 1
  while (next < lines.length && (lines[next] ?? '').trim() === '') next++
  if (next >= lines.length) return false
  const nextLine = lines[next] ?? ''
  const nextIndent = indentOf(nextLine)
  const nextKind = listItemKind(nextLine.slice(nextIndent))

  for (let i = blankIdx - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue
    const lineIndent = indentOf(line)
    const afterIndent = line.slice(lineIndent)
    const kind = listItemKind(afterIndent)
    if (kind) {
      const contentCol = lineIndent + markerWidth(afterIndent)
      if (nextIndent >= contentCol) return true
      if (nextKind && nextIndent === lineIndent && kind === nextKind) return true
      if (nextIndent < lineIndent) continue
      return false
    }
    // Non-list line (a paragraph or a deeper child block): keep scanning upward
    // for the list item that owns this region.
  }
  return false
}

function listItemKind(afterIndent: string): ListKind | null {
  if (/^\d+\.\s+/.test(afterIndent)) return 'ordered'
  if (/^[-*+]\s+/.test(afterIndent)) return 'unordered'
  return null
}

/** Width of the list marker prefix (`1. ` → 3, `- ` → 2) on an already-dedented line. */
function markerWidth(afterIndent: string): number {
  const ol = /^(\d+\.\s+)/.exec(afterIndent)
  if (ol) return (ol[1] ?? '').length
  const ul = /^([-*+]\s+)/.exec(afterIndent)
  if (ul) return (ul[1] ?? '').length
  return 0
}

/** Number of leading space/tab characters. Mirrors the parser's `indentOf`. */
function indentOf(line: string): number {
  let n = 0
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++
  return n
}
