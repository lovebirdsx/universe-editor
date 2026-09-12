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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { addCodeHtmlBytes, bumpHeapFlow } from '../../services/memory/heapFlowCounters.js'
import { MonacoLoader } from '../editor/monaco/MonacoLoader.js'
import { resolveLanguageId } from '../editor/monaco/languageId.js'
import { useMarkdownStreaming } from '../markdown/markdownStreamingContext.js'
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
    endLine?: number,
    opts?: { toSide?: boolean },
  ) => void
}

export function CodeBlock({ code, lang, line, onOpenFilePath }: CodeBlockProps) {
  const streaming = useMarkdownStreaming()
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const codeRef = useRef<HTMLElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Best-effort: leave the button in its idle state on failure.
    }
  }, [code])

  useEffect(() => {
    // Tokenizing a fence that grows every frame costs ~5-10x the source in HTML
    // and replaces the whole <code> subtree each time. Clear before returning:
    // a recycled instance would otherwise keep showing a shorter fence's result.
    if (streaming) {
      setHtml(null)
      bumpHeapFlow('colorize.skip', code.length)
      return
    }
    if (!lang) {
      setHtml(null)
      return
    }
    let cancelled = false
    bumpHeapFlow('colorize', code.length)
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
  }, [code, lang, streaming])

  // The colorized HTML is the largest V8-resident string a code block holds, so the
  // holder total has to follow it when it is replaced and when the block unmounts.
  const htmlBytes = useRef(0)
  useEffect(() => {
    const next = html === null ? 0 : html.length * 2
    if (next === htmlBytes.current) return
    addCodeHtmlBytes(next - htmlBytes.current)
    htmlBytes.current = next
  }, [html])
  useEffect(
    () => () => {
      if (htmlBytes.current > 0) addCodeHtmlBytes(-htmlBytes.current)
    },
    [],
  )

  // Linkify bare paths after each render of the block's content. Runs for both
  // the plain-text and colorized branches (the escaped HTML is injected below).
  // Skipped without an opener so paths never look clickable when they aren't.
  useEffect(() => {
    const el = codeRef.current
    if (!el || !onOpenFilePath || streaming) return
    linkifyFilePathsInCode(el, styles['codeBlockLink'] ?? '')
  }, [code, html, streaming, onOpenFilePath])

  const onClick = (e: React.MouseEvent<HTMLElement>): void => {
    if (!onOpenFilePath) return
    const target = resolveCodeBlockLinkClick(e.target)
    if (!target) return
    e.preventDefault()
    onOpenFilePath(target.path, target.line, target.col, target.endLine, {
      toSide: e.ctrlKey || e.metaKey,
    })
  }

  // Both branches inject HTML so the linkifier has a stable DOM to walk: plain
  // text is escaped first (Monaco already escapes its colorized output).
  const innerHtml = streaming || html === null ? escapeHtmlText(code) : html

  // The wrapper owns the hover copy button: it can't live inside <pre> because
  // `overflow-x: auto` would clip it and scroll it away with long lines.
  return (
    <div className={styles['codeBlockWrap']}>
      <pre
        className={styles['codeBlock']}
        data-lang={lang || 'text'}
        {...(line !== undefined ? { 'data-line': line } : {})}
      >
        <code ref={codeRef} onClick={onClick} dangerouslySetInnerHTML={{ __html: innerHtml }} />
      </pre>
      <button
        type="button"
        className={styles['codeBlockCopy']}
        data-tooltip={
          copied ? localize('codeBlock.copied', 'Copied') : localize('codeBlock.copy', 'Copy code')
        }
        aria-label={localize('codeBlock.copy', 'Copy code')}
        onClick={onCopy}
        data-testid="code-block-copy"
      >
        {copied ? (
          <Check size={14} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Copy size={14} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
