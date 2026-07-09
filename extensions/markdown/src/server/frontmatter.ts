/**
 * YAML frontmatter detection for the markdown language service.
 *
 * `vscode-markdown-languageservice` has no frontmatter awareness: its
 * `NoLinkRanges` only skips `code_block` / `fence` / `html_block` tokens, so a
 * `description: [hello]` inside the `---` preamble gets scanned as a reference
 * link and flagged as broken. We identify the frontmatter block here and, in the
 * parser, inject a synthetic `code_block` token spanning it so the whole preamble
 * is excluded from link extraction and diagnostics — matching VSCode's semantics.
 */

/** Zero-based, end-exclusive line range of a document's frontmatter block. */
export interface FrontmatterRange {
  readonly startLine: number
  /** Line after the closing fence — end-exclusive, for markdown-it token `map`. */
  readonly endLine: number
}

/**
 * Detect a YAML frontmatter block: an opening `---` on the very first line and a
 * closing `---` (or `...`) on a later line, with no blank line before the opener.
 * Returns the block's line range, or `undefined` when the document has none.
 */
export function detectFrontmatterRange(text: string): FrontmatterRange | undefined {
  const lines = text.split(/\r\n?|\n/)
  if (lines[0] === undefined || !/^---[ \t]*$/.test(lines[0])) return undefined
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[i] ?? '')) {
      return { startLine: 0, endLine: i + 1 }
    }
  }
  return undefined
}
