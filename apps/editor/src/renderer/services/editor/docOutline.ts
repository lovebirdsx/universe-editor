/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  docOutline — builds the DocumentSymbol tree for a built-in guide document
 *  (DocEditorInput). Unlike a file-backed markdown editor there is no Monaco
 *  model and no language server involved: the content is a static string from
 *  docRegistry, so headings are extracted with the same parseMarkdown AST the
 *  reader renders from. Symbol line numbers are 1-based (= AST line + 1), which
 *  is what the reader's data-line scroll mapping and the Outline view's
 *  reveal/active tracking both speak.
 *
 *  The shape mirrors the markdown language server's symbols: the name keeps its
 *  `#` markup (the Outline view strips it for display), the kind is
 *  SymbolKind.String (rendered as `#`), and a heading's range spans its whole
 *  section — up to the next same-or-higher-level heading — so the active-heading
 *  highlight tracks scrolled body text, not just heading lines.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'
import { inlineToText, parseMarkdown } from '../acp/markdownRenderer.js'

// SymbolKind.String, the kind the markdown language server uses for headings.
// Typed loosely to stay free of a runtime Monaco dependency (mirrors symbolTree.ts).
const HEADING_KIND = 14 as monaco.languages.SymbolKind

interface DocHeading {
  readonly level: number
  readonly name: string
  /** 0-based source line (parseMarkdown AST convention). */
  readonly line0: number
}

export function docSymbolsFromMarkdown(content: string): monaco.languages.DocumentSymbol[] {
  const headings: DocHeading[] = []
  for (const node of parseMarkdown(content)) {
    if (node.type === 'heading' && node.line !== undefined) {
      headings.push({
        level: node.level,
        name: `${'#'.repeat(node.level)} ${inlineToText(node.children)}`,
        line0: node.line,
      })
    }
  }

  // Same line normalisation parseMarkdown applies, so the document's last line
  // number lines up with the AST's 0-based lines.
  const totalLines = content.replace(/\r\n?/g, '\n').split('\n').length

  const roots: monaco.languages.DocumentSymbol[] = []
  const stack: { level: number; symbol: monaco.languages.DocumentSymbol }[] = []
  headings.forEach((heading, i) => {
    // The section ends where the next same-or-higher-level heading starts
    // (that heading's 0-based line IS the previous line's 1-based number).
    let endLineNumber = totalLines
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= heading.level) {
        endLineNumber = headings[j]!.line0
        break
      }
    }
    const startLineNumber = heading.line0 + 1
    const symbol: monaco.languages.DocumentSymbol = {
      name: heading.name,
      detail: '',
      kind: HEADING_KIND,
      tags: [],
      range: { startLineNumber, startColumn: 1, endLineNumber, endColumn: 1 },
      selectionRange: {
        startLineNumber,
        startColumn: 1,
        endLineNumber: startLineNumber,
        endColumn: 1,
      },
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) (parent.symbol.children as monaco.languages.DocumentSymbol[]).push(symbol)
    else roots.push(symbol)
    stack.push({ level: heading.level, symbol })
  })
  return roots
}
