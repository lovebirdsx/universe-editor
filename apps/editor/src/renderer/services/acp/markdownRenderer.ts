/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tiny safe markdown parser for ACP agent output. Produces an AST that a
 *  React renderer consumes; no raw HTML is ever emitted from user-supplied
 *  text — escaping is React's job (text nodes are escaped automatically).
 *
 *  Supported block tokens:
 *    - heading       `#` ... `######`
 *    - code fence    ```lang\n...\n```
 *    - blockquote    `> ...`
 *    - unordered     `- ` / `* ` / `+ `
 *    - ordered       `1. ` (any positive integer + `.`)
 *    - hr            `---` / `***` / `___`
 *    - table         GFM pipe table (`| a | b |` + `| --- | :-: |` row)
 *    - paragraph     anything else (joined runs of non-blank lines)
 *
 *  Supported inline tokens:
 *    - **bold**, __bold__
 *    - *italic*, _italic_
 *    - ~~strikethrough~~
 *    - `inline code`
 *    - [label](url)
 *    - ![alt](url)       (image — https/file only)
 *    - <url>           (autolink — http/https/file only)
 *    - bare http(s)://…
 *    - `\\` escapes the next punctuation char
 *--------------------------------------------------------------------------------------------*/

import { looksLikeFilePath, matchFilePathAt } from './filePathLink.js'

export type MdNode =
  | { readonly type: 'paragraph'; readonly children: readonly MdInline[]; readonly line?: number }
  | {
      readonly type: 'heading'
      readonly level: 1 | 2 | 3 | 4 | 5 | 6
      readonly children: readonly MdInline[]
      readonly line?: number
    }
  | {
      readonly type: 'code_fence'
      readonly lang: string
      readonly code: string
      readonly line?: number
    }
  | {
      readonly type: 'list'
      readonly ordered: boolean
      readonly items: readonly MdListItem[]
      readonly line?: number
    }
  | { readonly type: 'blockquote'; readonly children: readonly MdInline[]; readonly line?: number }
  | {
      readonly type: 'frontmatter'
      readonly entries: readonly (readonly [key: string, value: string])[]
      readonly line?: number
    }
  | {
      readonly type: 'table'
      readonly align: readonly (TableAlign | null)[]
      readonly header: readonly (readonly MdInline[])[]
      readonly rows: readonly (readonly (readonly MdInline[])[])[]
      readonly line?: number
    }
  | { readonly type: 'hr'; readonly line?: number }

export type TableAlign = 'left' | 'center' | 'right'

/**
 * One item of a list. `inline` is the item's own leading text (first line plus
 * any lazy top-level continuation lines), rendered directly inside the `<li>`.
 * `children` holds indented block content (nested lists, code fences, extra
 * paragraphs, blockquotes …) and is omitted entirely when the item has none, so
 * plain items keep their simple shape.
 */
export type MdListItem = {
  readonly inline: readonly MdInline[]
  readonly checked: boolean | null
  readonly children?: readonly MdNode[]
}

export type MdInline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'bold'; readonly children: readonly MdInline[] }
  | { readonly type: 'italic'; readonly children: readonly MdInline[] }
  | { readonly type: 'strike'; readonly children: readonly MdInline[] }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'link'; readonly href: string; readonly children: readonly MdInline[] }
  | {
      readonly type: 'filepath'
      readonly path: string
      readonly line?: number
      readonly col?: number
    }
  | { readonly type: 'image'; readonly src: string; readonly alt: string }
  | { readonly type: 'softbreak' }

/**
 * Options for {@link parseMarkdown}. `frontmatter` enables YAML preamble
 * handling: when set, a `---`-fenced block at the very start of the document
 * becomes a single `frontmatter` node instead of an `hr` + paragraph. Off by
 * default so the ACP chat and other streaming consumers treat `---` as an `hr`.
 */
export interface ParseMarkdownOptions {
  readonly frontmatter?: boolean
}

/**
 * Parse a markdown string into an array of block-level nodes. Pure — no React,
 * no DOM. Safe to call repeatedly; results can be cached upstream by message
 * id since the AST is stable for a stable input.
 */
export function parseMarkdown(input: string, options?: ParseMarkdownOptions): readonly MdNode[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  const out: MdNode[] = []
  let i = 0

  // YAML frontmatter: a `---` on the first line closed by a later `---`/`...`.
  // Emitted as one node the preview renders as a table; skipped otherwise.
  if (options?.frontmatter === true && /^---[ \t]*$/.test(lines[0] ?? '')) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[j] ?? '')) {
        out.push({
          type: 'frontmatter',
          entries: parseFrontmatterEntries(lines.slice(1, j)),
          line: 0,
        })
        i = j + 1
        break
      }
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''

    // Skip blank lines between blocks.
    if (line.trim() === '') {
      i++
      continue
    }

    // Source line of this block (0-based, = monaco lineNumber - 1). Consumed by
    // the markdown preview for scroll sync; ACP chat ignores it.
    const blockStart = i

    // Fenced code block. We require the closing fence at column 0 to keep
    // the parser cheap; if the agent emits a fence inside indented content
    // we treat the rest as code until we see the closing line.
    const fence = /^```(\S*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      i++
      const codeLines: string[] = []
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        codeLines.push(lines[i] ?? '')
        i++
      }
      // Consume the closing fence if present; an unterminated fence still
      // produces a code block ending at EOF (defensive against partial streams).
      if (i < lines.length) i++
      out.push({ type: 'code_fence', lang, code: codeLines.join('\n'), line: blockStart })
      continue
    }

    // ATX heading: 1–6 leading hashes, then a space, then the text.
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
      out.push({
        type: 'heading',
        level,
        children: parseInline(heading[2] ?? ''),
        line: blockStart,
      })
      i++
      continue
    }

    // Horizontal rule — three or more of the same char, optional spaces.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push({ type: 'hr', line: blockStart })
      i++
      continue
    }

    // Blockquote — collect consecutive `> ` lines into one block.
    if (/^\s*>/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^\s*>\s?/, ''))
        i++
      }
      out.push({ type: 'blockquote', children: parseInline(buf.join('\n')), line: blockStart })
      continue
    }

    // Lists — homogeneous run of `- ` / `* ` / `+ ` (unordered) or `<n>. `
    // (ordered) lines. A sibling item sits at the list's base indent; a plain
    // top-level line before any child is lazy continuation of the item's text;
    // lines indented past the marker are the item's child blocks (nested lists,
    // code fences, extra paragraphs …), dedented and parsed recursively. Blank
    // lines between same-kind items make a loose list.
    const ul = /^\s*[-*+]\s+/.test(line)
    const ol = /^\s*\d+\.\s+/.test(line)
    if (ul || ol) {
      const ordered = ol
      const markerRe = ordered ? /^(\d+\.\s+)/ : /^([-*+]\s+)/
      const baseIndent = indentOf(line)
      const isSibling = (l: string): boolean =>
        indentOf(l) === baseIndent && markerRe.test(l.slice(baseIndent))
      const items: MdListItem[] = []
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        if (cur.trim() === '') {
          // Loose list: a blank between two same-kind siblings stays one list.
          let next = i + 1
          while (next < lines.length && (lines[next] ?? '').trim() === '') next++
          if (next < lines.length && isSibling(lines[next] ?? '')) {
            i = next
            continue
          }
          break
        }
        if (!isSibling(cur)) break
        const rest = cur.slice(baseIndent)
        const marker = markerRe.exec(rest)![1] ?? ''
        // Content column = marker prefix width; child blocks indent to here.
        const markerWidth = baseIndent + marker.length
        const firstLine = rest.slice(marker.length)
        i++
        const continuationLines: string[] = []
        const childLines: string[] = []
        let sawChild = false
        while (i < lines.length) {
          const nextLine = lines[i] ?? ''
          if (nextLine.trim() === '') {
            // A blank belongs to this item only when more-indented child content
            // follows it; otherwise it ends the item (the outer loop decides
            // whether a sibling continues the list).
            let j = i + 1
            while (j < lines.length && (lines[j] ?? '').trim() === '') j++
            if (j < lines.length && indentOf(lines[j] ?? '') >= markerWidth) {
              for (; i < j; i++) childLines.push('')
              sawChild = true
              continue
            }
            break
          }
          if (indentOf(nextLine) >= markerWidth) {
            childLines.push(nextLine.slice(markerWidth))
            sawChild = true
            i++
            continue
          }
          // Dedented line: a sibling item or an outer block ends this item.
          if (isSibling(nextLine)) break
          if (isListItemStart(nextLine)) break
          if (isTopLevelBlockStart(nextLine, lines[i + 1] ?? '')) break
          // Lazy continuation of the leading text — only before any child block.
          if (sawChild) break
          continuationLines.push(nextLine)
          i++
        }
        const children = childLines.some((l) => l.trim() !== '')
          ? parseMarkdown(childLines.join('\n'))
          : undefined
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(firstLine)
        const leadingText = taskMatch ? (taskMatch[2] ?? '') : firstLine
        const itemText = [leadingText, ...continuationLines].join('\n')
        items.push({
          inline: [...parseInline(itemText)],
          checked: taskMatch ? taskMatch[1] !== ' ' : null,
          ...(children !== undefined ? { children } : {}),
        })
      }
      out.push({ type: 'list', ordered, items, line: blockStart })
      continue
    }

    // GFM pipe table — a header row containing a `|`, immediately followed by
    // a delimiter row (`| --- | :-: |`). Data rows are the following lines that
    // still contain a `|`; a blank line (or a non-pipe line) ends the table.
    if (line.includes('|') && isTableDelimiterRow(lines[i + 1] ?? '')) {
      const align = parseTableDelimiter(lines[i + 1] ?? '')
      const cols = align.length
      const header = splitTableRow(line, cols)
      i += 2
      const rows: MdInline[][][] = []
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        if (cur.trim() === '' || !cur.includes('|')) break
        rows.push(splitTableRow(cur, cols))
        i++
      }
      out.push({ type: 'table', align, header, rows, line: blockStart })
      continue
    }

    // Paragraph — accumulate non-blank, non-block-start lines.
    const para: string[] = [line]
    i++
    while (i < lines.length) {
      const cur = lines[i] ?? ''
      if (cur.trim() === '') break
      if (/^```/.test(cur)) break
      if (/^#{1,6}\s/.test(cur)) break
      if (/^\s*>/.test(cur)) break
      if (/^\s*[-*+]\s+/.test(cur)) break
      if (/^\s*\d+\.\s+/.test(cur)) break
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(cur)) break
      // A table starting on the next line (header + delimiter) ends the paragraph.
      if (cur.includes('|') && isTableDelimiterRow(lines[i + 1] ?? '')) break
      para.push(cur)
      i++
    }
    out.push({ type: 'paragraph', children: parseInline(para.join('\n')), line: blockStart })
  }
  return out
}

function isListItemStart(line: string): boolean {
  return /^\s*(?:[-*+]|\d+\.)\s+/.test(line)
}

/**
 * Parse frontmatter body lines into `[key, value]` pairs for the preview table.
 * Deliberately minimal (no YAML dependency): only top-level `key: value` lines
 * are split; nested/indented lines and block scalars are appended to the current
 * key's value verbatim so nothing is lost. Comment lines (`#`) are skipped.
 */
function parseFrontmatterEntries(lines: readonly string[]): (readonly [string, string])[] {
  const entries: [string, string][] = []
  for (const raw of lines) {
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const topLevel = /^([^\s:#][^:]*?):(?:\s+(.*))?$/.exec(raw)
    if (topLevel && !/^\s/.test(raw)) {
      entries.push([topLevel[1] ?? '', (topLevel[2] ?? '').trim()])
      continue
    }
    // Continuation of the previous key (nested map / list item / block scalar).
    const last = entries[entries.length - 1]
    if (last) last[1] = last[1] === '' ? raw.trim() : `${last[1]}\n${raw.trim()}`
  }
  return entries
}

/** Number of leading space characters (tabs count as one; agents emit spaces). */
function indentOf(line: string): number {
  let n = 0
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++
  return n
}

function isTopLevelBlockStart(line: string, nextLine: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    (line.includes('|') && isTableDelimiterRow(nextLine))
  )
}

/**
 * Inline parser. Scans left-to-right, building a flat list of {@link MdInline}
 * nodes. We accept only http/https/file URLs for autolinks and bare URLs to
 * keep the renderer's attack surface small.
 */
export function parseInline(text: string): readonly MdInline[] {
  const out: MdInline[] = []
  let buf = ''
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ type: 'text', text: buf })
      buf = ''
    }
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]!

    // Escapes: `\X` emits X verbatim when X is punctuation.
    if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!<>]/.test(text[i + 1]!)) {
      buf += text[i + 1]
      i += 2
      continue
    }

    // Soft break — a `\n` becomes a softbreak inline node.
    if (ch === '\n') {
      flush()
      out.push({ type: 'softbreak' })
      i++
      continue
    }

    // Inline code: `...`, or `` `...` `` when the content itself contains
    // single backticks. Closing delimiter must use the same backtick-run length.
    if (ch === '`') {
      const tickCount = countBacktickRun(text, i)
      const close = findClosingBacktickRun(text, i + tickCount, tickCount)
      if (close !== -1) {
        flush()
        out.push({
          type: 'code',
          text: normalizeCodeSpanText(text.slice(i + tickCount, close)),
        })
        i = close + tickCount
        continue
      }
      buf += text.slice(i, i + tickCount)
      i += tickCount
      continue
    }

    // Strikethrough: ~~text~~
    if (ch === '~' && text[i + 1] === '~') {
      const closeIdx = text.indexOf('~~', i + 2)
      if (closeIdx !== -1 && closeIdx > i + 2) {
        flush()
        out.push({ type: 'strike', children: parseInline(text.slice(i + 2, closeIdx)) })
        i = closeIdx + 2
        continue
      }
    }

    // Image: ![alt](url) — must be checked before link since `!` precedes `[`.
    if (ch === '!' && text[i + 1] === '[') {
      const labelEnd = findMatching(text, i + 1, '[', ']')
      if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
        const urlEnd = findMatching(text, labelEnd + 1, '(', ')')
        if (urlEnd !== -1) {
          const alt = text.slice(i + 2, labelEnd)
          const src = text.slice(labelEnd + 2, urlEnd).trim()
          if (isImageSrc(src)) {
            flush()
            out.push({ type: 'image', src, alt })
            i = urlEnd + 1
            continue
          }
        }
      }
    }

    // Strong (** or __). Look for a matching pair of identical delimiters that
    // isn't part of a triple (`***` is bold+italic, handled by the recursion).
    // `_` does not open mid-word (GFM intraword rule), so `foo__bar__` stays literal.
    if (
      (ch === '*' || ch === '_') &&
      text[i + 1] === ch &&
      !(ch === '_' && isWordChar(text[i - 1]))
    ) {
      const end = findBoldClose(text, i + 2, ch)
      if (end !== -1 && end > i + 2) {
        flush()
        out.push({ type: 'bold', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    // Emphasis (* or _). Find the next *single* delimiter — skip over `**`
    // sequences so `*a **b** c*` parses to italic(a, bold(b), c) rather than
    // grabbing the inner `**` as the closing delimiter. `_` does not open
    // mid-word (GFM intraword rule), so `foo_bar_1` keeps its underscores.
    if ((ch === '*' || ch === '_') && !(ch === '_' && isWordChar(text[i - 1]))) {
      const end = findItalicClose(text, i + 1, ch)
      if (end !== -1 && end > i + 1) {
        flush()
        out.push({ type: 'italic', children: parseInline(text.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    // Link: [label](url). We require a balanced parens count > 0.
    if (ch === '[') {
      const labelEnd = findMatching(text, i, '[', ']')
      if (labelEnd !== -1 && text[labelEnd + 1] === '(') {
        const urlEnd = findMatching(text, labelEnd + 1, '(', ')')
        if (urlEnd !== -1) {
          const label = text.slice(i + 1, labelEnd)
          const href = text.slice(labelEnd + 2, urlEnd).trim()
          // An image embedded as a plain link — e.g. `[@image](data:image/..)`,
          // how agents without an ACP image block carry a picture — renders as a
          // real image (the label becomes its alt text).
          if (isImageDataUrl(href)) {
            flush()
            out.push({ type: 'image', src: href, alt: label })
            i = urlEnd + 1
            continue
          }
          if (
            isSafeHref(href) ||
            looksLikeFilePath(href) ||
            isAnchorHref(href) ||
            (href.includes('#') &&
              !href.startsWith('#') &&
              looksLikeFilePath(href.slice(0, href.indexOf('#'))))
          ) {
            flush()
            out.push({ type: 'link', href, children: parseInline(label) })
            i = urlEnd + 1
            continue
          }
        }
      }
    }

    // Autolink: <url> where url is http(s) or file; also accept explicit
    // angle-wrapped file paths so Windows install paths with spaces stay intact.
    if (ch === '<') {
      const close = text.indexOf('>', i + 1)
      if (close !== -1) {
        const candidate = text.slice(i + 1, close).trim()
        if (isSafeHref(candidate) || looksLikeFilePath(candidate)) {
          flush()
          out.push({
            type: 'link',
            href: candidate,
            children: [{ type: 'text', text: candidate }],
          })
          i = close + 1
          continue
        }
      }
    }

    // Bare URL autolink.
    const url = matchBareUrl(text, i)
    if (url) {
      flush()
      out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] })
      i += url.length
      continue
    }

    // Bare file path: `src/foo/bar.ts:10:5`. Requires a dir separator (see
    // filePathLink) so plain words aren't mistaken for links.
    const fp = matchFilePathAt(text, i)
    if (fp) {
      flush()
      out.push({
        type: 'filepath',
        path: fp.path,
        ...(fp.line !== undefined ? { line: fp.line } : {}),
        ...(fp.col !== undefined ? { col: fp.col } : {}),
      })
      i += fp.full.length
      continue
    }

    buf += ch
    i++
  }
  flush()
  return out
}

/**
 * Find the index of the matching closing delimiter for an opening one at
 * {@link start}, accounting for nested same-kind pairs. Returns -1 if the
 * input runs out before finding a balanced match.
 */
function findMatching(text: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function countBacktickRun(text: string, start: number): number {
  let count = 0
  while (text[start + count] === '`') count++
  return count
}

function findClosingBacktickRun(text: string, start: number, tickCount: number): number {
  let i = start
  while (i < text.length) {
    if (text[i] !== '`') {
      i++
      continue
    }
    const runLength = countBacktickRun(text, i)
    if (runLength === tickCount) return i
    i += runLength
  }
  return -1
}

function normalizeCodeSpanText(text: string): string {
  const normalized = text.replace(/\r\n?|\n/g, ' ')
  if (normalized.startsWith(' ') && normalized.endsWith(' ') && /[^ ]/.test(normalized)) {
    return normalized.slice(1, -1)
  }
  return normalized
}

/**
 * Scan forward for the closing `**` (or `__`) bold delimiter, skipping
 * escaped chars. Returns the index of the first `delim` char of the closing
 * pair, or -1 if none found. For `_`, the closing pair must not be followed by
 * a word char (GFM intraword rule).
 */
function findBoldClose(text: string, start: number, delim: string): number {
  let j = start
  while (j < text.length - 1) {
    const cj = text[j]
    if (cj === '\\') {
      j += 2
      continue
    }
    if (cj === delim && text[j + 1] === delim) {
      if (delim === '_' && isWordChar(text[j + 2])) {
        j += 2
        continue
      }
      return j
    }
    j++
  }
  return -1
}

/**
 * Scan forward for the closing single-char italic delimiter. Skip over `**`
 * sequences so they bind to the bold parser instead of getting swallowed as
 * the italic boundary. For `_`, the closing delimiter must not be followed by
 * a word char (GFM intraword rule).
 */
function findItalicClose(text: string, start: number, delim: string): number {
  let j = start
  while (j < text.length) {
    const cj = text[j]
    if (cj === '\\') {
      j += 2
      continue
    }
    if (cj === delim) {
      if (text[j + 1] === delim) {
        j += 2
        continue
      }
      if (delim === '_' && isWordChar(text[j + 1])) {
        j++
        continue
      }
      return j
    }
    j++
  }
  return -1
}

/** A word char for GFM intraword emphasis: ASCII letters, digits, underscore. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

/** Allow only http(s) and file URLs. */
export function isSafeHref(href: string): boolean {
  return /^(?:https?:|file:)/i.test(href)
}

/**
 * True for an inline base64 image data URL (`data:image/png;base64,...`). Only
 * `image/*` is allowed — never arbitrary `data:` (which could carry scripts).
 * Agents that lack an ACP image content block sometimes embed a picture as a
 * markdown link/image with such a URL; we render those as real images instead of
 * leaking a multi-KB string into the text.
 */
export function isImageDataUrl(href: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(href)
}

/**
 * True for an image `src` we are willing to render. Allows http(s), file:,
 * `data:image` and plain local paths (relative or absolute) — the latter are
 * resolved to a loadable `universe-app://` URL at render time
 * ({@link asPreviewResourceUri}). Rejects other schemes (`javascript:`,
 * `vbscript:`, non-image `data:`) so untrusted markdown can't smuggle a script.
 */
export function isImageSrc(src: string): boolean {
  if (isSafeHref(src) || isImageDataUrl(src)) return true
  if (src.startsWith('data:')) return false
  // A URI with some other scheme (e.g. `javascript:`) — refuse. A Windows drive
  // path like `C:\a.png` is not a scheme (single-letter + backslash), so exclude
  // that shape from the scheme test.
  if (/^[a-z][a-z0-9.+-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return false
  return src.length > 0
}

/** True for a same-document anchor link like `#section` (fragment only). */
export function isAnchorHref(href: string): boolean {
  return href.length > 1 && href.startsWith('#')
}

/**
 * Slugify heading text into a GitHub-style fragment id: lowercased, spaces to
 * hyphens, punctuation stripped, non-ASCII (incl. CJK) kept verbatim. This must
 * match how `#anchor` links are written, so `## 子结构：ITalkItem` becomes
 * `子结构italkitem` — the same slug an author would target with `(#子结构italkitem)`.
 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
}

// ---------------------------------------------------------------------------
// GFM tables
// ---------------------------------------------------------------------------

const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

/** True when a line is a GFM table delimiter row (`| --- | :-: | ---: |`). */
function isTableDelimiterRow(line: string): boolean {
  return line.includes('-') && TABLE_DELIMITER_RE.test(line)
}

/** Parse a delimiter row into per-column alignments. */
function parseTableDelimiter(line: string): (TableAlign | null)[] {
  return splitPipes(line).map((cell) => {
    const c = cell.trim()
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/**
 * Split a table row into exactly {@link cols} cells of parsed inline content.
 * Extra cells are dropped and missing cells padded with empty content, matching
 * GFM's column-count normalization against the header.
 */
function splitTableRow(line: string, cols: number): MdInline[][] {
  const cells = splitPipes(line).map((cell) => [...parseInline(cell.trim())])
  while (cells.length < cols) cells.push([])
  cells.length = cols
  return cells
}

/**
 * Split a pipe-delimited row into raw cell strings. Strips one optional leading
 * and trailing `|`, then splits on unescaped `|` (so `\|` stays a literal pipe).
 */
function splitPipes(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === '\\' && i + 1 < s.length) {
      buf += s[i + 1] === '|' ? '|' : ch + s[i + 1]
      i++
      continue
    }
    if (ch === '|') {
      cells.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf)
  return cells
}

const BARE_URL_RE = /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/i

function matchBareUrl(text: string, i: number): string | null {
  // Avoid matching mid-word like `foohttp://...`
  if (i > 0 && /[A-Za-z0-9_/.~%-]/.test(text[i - 1] ?? '')) return null
  const slice = text.slice(i)
  const m = BARE_URL_RE.exec(slice)
  return m ? (m[1] ?? null) : null
}
