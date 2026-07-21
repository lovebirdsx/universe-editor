/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  codeBlockLinks — turn bare file paths inside a rendered code block into
 *  clickable links. Runs as a DOM post-processor over the block's content (plain
 *  escaped text or Monaco's colorized HTML), so paths become links without
 *  disturbing the surrounding syntax highlighting. Reuses the same grammar as
 *  rendered prose and the terminal link provider (FILE_PATH_PATTERN), so exactly
 *  the same set of paths is recognized everywhere.
 *
 *  A path that Monaco split across several token spans (a bare, unquoted path
 *  tokenized as `ident / ident . ext`) stays plain — matching is per text node,
 *  which covers the common cases (paths inside strings, comments, or plain-text
 *  fences) while never breaking span structure.
 *--------------------------------------------------------------------------------------------*/

import { FILE_PATH_PATTERN } from '../../services/acp/filePathLink.js'

// `u` flag: FILE_PATH_PATTERN embeds Unicode property classes (\p{L}\p{N}) so
// CJK file names are recognized. `g` so we can scan a text node left-to-right.
const FILE_LINK_RE = new RegExp(FILE_PATH_PATTERN, 'gu')

const LINK_MARKER = 'codelink'

/** Escape a raw string for safe use as HTML text content (no attributes). */
export function escapeHtmlText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

/**
 * Wrap every bare file path found in {@link root}'s text nodes in an anchor
 * carrying the path/line/col as data attributes. Idempotent: text already inside
 * a generated anchor is skipped, so a repeated call (e.g. React StrictMode's
 * double effect invocation) won't double-wrap.
 */
export function linkifyFilePathsInCode(root: HTMLElement, linkClass: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  // Collect first — mutating the tree while walking it is unsafe.
  const textNodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node as Text
    if (text.data.length === 0) continue
    if (text.parentElement?.closest(`a[data-${LINK_MARKER}]`)) continue
    textNodes.push(text)
  }
  for (const textNode of textNodes) replaceTextNode(textNode, linkClass)
}

function replaceTextNode(textNode: Text, linkClass: string): void {
  const text = textNode.data
  FILE_LINK_RE.lastIndex = 0
  let frag: DocumentFragment | null = null
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_LINK_RE.exec(text)) !== null) {
    const full = m[0] ?? ''
    if (full.length === 0) {
      FILE_LINK_RE.lastIndex++
      continue
    }
    if (frag === null) frag = document.createDocumentFragment()
    const before = text.slice(lastIndex, m.index)
    if (before.length > 0) frag.appendChild(document.createTextNode(before))
    frag.appendChild(makeAnchor(full, m, linkClass))
    lastIndex = m.index + full.length
  }
  if (frag === null) return
  const rest = text.slice(lastIndex)
  if (rest.length > 0) frag.appendChild(document.createTextNode(rest))
  textNode.parentNode?.replaceChild(frag, textNode)
}

function makeAnchor(full: string, m: RegExpExecArray, linkClass: string): HTMLAnchorElement {
  const a = document.createElement('a')
  a.className = linkClass
  a.href = full
  a.textContent = full
  a.setAttribute(`data-${LINK_MARKER}`, '1')
  a.setAttribute('data-testid', 'md-codeblock-filepath')
  a.dataset['path'] = m[1] ?? full
  const line = m[2] ?? m[4]
  const col = m[3] ?? m[5]
  if (line !== undefined) a.dataset['line'] = line
  if (col !== undefined) a.dataset['col'] = col
  return a
}

/** Parsed location of a clicked code-block link, read back from its dataset. */
export interface CodeBlockLinkTarget {
  readonly path: string
  readonly line: number | undefined
  readonly col: number | undefined
}

/**
 * Resolve a click inside a code block to the file-path anchor it landed on (if
 * any), reading the path/line/col stashed on the anchor by {@link makeAnchor}.
 */
export function resolveCodeBlockLinkClick(target: EventTarget | null): CodeBlockLinkTarget | null {
  const anchor =
    target instanceof Element ? target.closest<HTMLElement>(`a[data-${LINK_MARKER}]`) : null
  const path = anchor?.dataset['path']
  if (!path) return null
  const line = anchor.dataset['line']
  const col = anchor.dataset['col']
  return {
    path,
    line: line !== undefined ? Number(line) : undefined,
    col: col !== undefined ? Number(col) : undefined,
  }
}
