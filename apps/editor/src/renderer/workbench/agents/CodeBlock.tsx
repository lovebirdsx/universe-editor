/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodeBlock — renders a fenced code block with syntax highlighting via
 *  Monaco's `editor.colorize()` API. Falls back to plain escaped <pre> when
 *  the language is unknown, Monaco hasn't loaded yet, or the colorize call
 *  fails. Monaco's colorize output is trusted HTML (it escapes content), so
 *  dangerouslySetInnerHTML is safe here.
 *
 *  Bare file paths inside the block are turned into clickable links by a DOM
 *  post-processor (see codeBlockLinks); clicks are delegated to `onOpenFilePath`
 *  so a path in a code block opens the file just like one in prose.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { MonacoLoader } from '../editor/monaco/MonacoLoader.js'
import { resolveLanguageId } from '../editor/monaco/languageId.js'
import {
  escapeHtmlText,
  linkifyFilePathsInCode,
  resolveCodeBlockLinkClick,
} from './codeBlockLinks.js'
import styles from './agents.module.css'

interface CodeBlockProps {
  readonly code: string
  readonly lang?: string
  readonly line?: number
  /**
   * Open a bare file path clicked inside the block. When omitted, paths still
   * render as links but clicking them is a no-op (static consumers). The signature
   * matches useMarkdownFileLink's opener.
   */
  readonly onOpenFilePath?: (
    path: string,
    line?: number,
    col?: number,
    opts?: { toSide?: boolean },
  ) => void
}

export function CodeBlock({ code, lang, line, onOpenFilePath }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null)
  const codeRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!lang) {
      setHtml(null)
      return
    }
    let cancelled = false
    void MonacoLoader.ensureInitialized()
      .then((monaco) => {
        const id = resolveLanguageId(lang, monaco)
        return id ? monaco.editor.colorize(code, id, { tabSize: 2 }) : null
      })
      .then((rendered) => {
        if (!cancelled) setHtml(rendered)
      })
      .catch(() => {
        if (!cancelled) setHtml(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  // Linkify bare paths after each render of the block's content. Runs for both
  // the plain-text and colorized branches (the escaped HTML is injected below).
  // Skipped without an opener so paths never look clickable when they aren't.
  useEffect(() => {
    const el = codeRef.current
    if (!el || !onOpenFilePath) return
    linkifyFilePathsInCode(el, styles['codeBlockLink'] ?? '')
  }, [code, html, onOpenFilePath])

  const onClick = (e: React.MouseEvent<HTMLElement>): void => {
    if (!onOpenFilePath) return
    const target = resolveCodeBlockLinkClick(e.target)
    if (!target) return
    e.preventDefault()
    onOpenFilePath(target.path, target.line, target.col, { toSide: e.ctrlKey || e.metaKey })
  }

  // Both branches inject HTML so the linkifier has a stable DOM to walk: plain
  // text is escaped first (Monaco already escapes its colorized output).
  const innerHtml = html === null ? escapeHtmlText(code) : html

  return (
    <pre
      className={styles['codeBlock']}
      data-lang={lang || 'text'}
      {...(line !== undefined ? { 'data-line': line } : {})}
    >
      <code ref={codeRef} onClick={onClick} dangerouslySetInnerHTML={{ __html: innerHtml }} />
    </pre>
  )
}
