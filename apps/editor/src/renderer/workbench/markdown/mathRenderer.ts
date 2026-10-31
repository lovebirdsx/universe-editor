/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  KaTeX wrapper for markdown math. Lives in its own lazy chunk (see mathLoader)
 *  so the ~280KB parser and its CSS/fonts only load when a document actually
 *  contains a formula.
 *
 *  Security: KaTeX output is inserted with dangerouslySetInnerHTML elsewhere, so
 *  this wrapper is the trust boundary. `trust: false` makes \href / \url /
 *  \includegraphics / \html* emit inert error text instead of URLs, images or
 *  raw HTML; `throwOnError: false` keeps a bad formula from throwing mid-render.
 *  Macros are copied per call so a TeX \gdef/\newcommand can never redefine
 *  anything for the next formula (no globalGroup), and maxExpand/maxSize bound
 *  the work a hostile formula can cause.
 *--------------------------------------------------------------------------------------------*/

import 'katex/dist/katex.min.css'
import katex from 'katex'

/**
 * Render one formula to an HTML string. Never throws: a failure yields `''` and
 * the caller falls back to showing the raw TeX.
 */
export function renderMathToString(
  tex: string,
  display: boolean,
  macros: Readonly<Record<string, string>>,
): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      trust: false,
      throwOnError: false,
      strict: 'ignore',
      output: 'htmlAndMathml',
      maxExpand: 1000,
      maxSize: 100,
      errorColor: 'var(--vscode-errorForeground, #d1242f)',
      // Fresh copy per render: KaTeX mutates this object when the TeX itself
      // defines macros, and those definitions must not leak across formulas.
      macros: { ...macros },
    })
  } catch {
    return ''
  }
}
