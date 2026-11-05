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
 *
 *  Colorizing waits until the block is near the viewport. A session tab remount
 *  mounts every fence at once, and tokenizing all of them back to back is one
 *  long main-thread task; the plain-text branch renders the very same
 *  <pre><code> so the row height does not move when the highlight lands.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { writeClipboardText } from '@universe-editor/workbench-ui'
import { addCodeHtmlBytes, bumpHeapFlow } from '../../services/memory/heapFlowCounters.js'
import { MonacoLoader } from '../editor/monaco/MonacoLoader.js'
import { resolveLanguageId } from '../editor/monaco/languageId.js'
import { isOpenTargetEnter, resolveOpenTarget } from '../../services/editor/openTarget.js'
import type { OpenMarkdownLinkOptions } from '../markdown/useMarkdownFileLink.js'
import { useMarkdownStreaming } from '../markdown/markdownStreamingContext.js'
import {
  escapeHtmlText,
  linkifyFilePathsInCode,
  resolveCodeBlockLinkClick,
} from './codeBlockLinks.js'
import styles from './agents.module.css'

/**
 * Blocks that scroll into range together are reported in one observer batch, and
 * each colorize is synchronous. One block per macrotask keeps that batch from
 * landing as a single long task without serializing later scrolls behind it.
 */
const highlightQueue: Array<() => void> = []
let pumpScheduled = false

function pumpHighlights(): void {
  pumpScheduled = false
  highlightQueue.shift()?.()
  if (highlightQueue.length > 0) {
    pumpScheduled = true
    setTimeout(pumpHighlights, 0)
  }
}

function scheduleHighlight(release: () => void): void {
  highlightQueue.push(release)
  if (pumpScheduled) return
  pumpScheduled = true
  setTimeout(pumpHighlights, 0)
}

const VIEWPORT_MARGIN = '600px 0px'

/**
 * Plain HTML for the un-highlighted branch. Monaco's colorizer splits on line
 * breaks and emits a <br/> after every line, so a fence body ending with a
 * newline yields one extra empty line; the literal text needs the same trailing
 * break, otherwise the block grows a line the moment the highlight lands.
 */
function plainCodeHtml(code: string): string {
  const escaped = escapeHtmlText(code)
  return code === '' || /(\r\n|\r|\n)$/.test(code) ? `${escaped}<br/>` : escaped
}

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
    opts?: OpenMarkdownLinkOptions,
  ) => void
}

export function CodeBlock({ code, lang, line, onOpenFilePath }: CodeBlockProps) {
  const streaming = useMarkdownStreaming()
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [nearViewport, setNearViewport] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const codeRef = useRef<HTMLElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  // Stop watching as soon as the block has been released (and on unmount): a
  // highlighted block must keep its highlight when it scrolls back out.
  useEffect(() => {
    if (nearViewport) return
    const el = wrapRef.current
    const doc = el?.ownerDocument
    const view = doc?.defaultView ?? null
    const Observer = view?.IntersectionObserver
    // A realm without a laid-out viewport (happy-dom, an unshown window) ships
    // an observer that never reports; there is nothing to defer for, so keep
    // the eager behavior those environments had before this gate existed.
    if (!el || !Observer || (doc?.documentElement?.clientHeight ?? 0) === 0) {
      setNearViewport(true)
      return
    }
    let disposed = false
    const observer = new Observer(
      (entries) => {
        if (disposed || !entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        scheduleHighlight(() => {
          if (!disposed) setNearViewport(true)
        })
      },
      { rootMargin: VIEWPORT_MARGIN },
    )
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [nearViewport])

  const onCopy = useCallback(async () => {
    try {
      await writeClipboardText(code)
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
    if (!streaming) return
    setHtml(null)
    bumpHeapFlow('colorize.skip', code.length)
  }, [code, streaming])

  useEffect(() => {
    if (streaming) return
    if (!lang) {
      setHtml(null)
      return
    }
    // Off-screen blocks stay plain text until the observer releases them; the
    // escaped text renders in the same <pre><code> box, so nothing reflows.
    if (!nearViewport) return
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
  }, [code, lang, streaming, nearViewport])

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
      target: resolveOpenTarget(e),
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (!onOpenFilePath) return
    if (!isOpenTargetEnter(e)) return
    const target = resolveCodeBlockLinkClick(e.target)
    if (!target) return
    e.preventDefault()
    onOpenFilePath(target.path, target.line, target.col, target.endLine, {
      target: resolveOpenTarget(e),
    })
  }

  // Both branches inject HTML so the linkifier has a stable DOM to walk: plain
  // text is escaped first (Monaco already escapes its colorized output). The
  // prop object is memoized because React diffs `dangerouslySetInnerHTML` by
  // identity: a fresh literal on every render rewrites innerHTML and wipes the
  // anchors added by the linkifier (copying a block re-renders this component).
  // A language-less fence never colorizes, so it has no line structure to match.
  const plainHtml = lang ? plainCodeHtml(code) : escapeHtmlText(code)
  const innerHtml = streaming || html === null ? plainHtml : html
  const innerHtmlProp = useMemo(() => ({ __html: innerHtml }), [innerHtml])

  // The wrapper owns the hover copy button: it can't live inside <pre> because
  // `overflow-x: auto` would clip it and scroll it away with long lines.
  return (
    <div ref={wrapRef} className={styles['codeBlockWrap']}>
      <pre
        className={styles['codeBlock']}
        data-lang={lang || 'text'}
        {...(line !== undefined ? { 'data-line': line } : {})}
      >
        <code
          ref={codeRef}
          onClick={onClick}
          onKeyDown={onKeyDown}
          dangerouslySetInnerHTML={innerHtmlProp}
        />
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
