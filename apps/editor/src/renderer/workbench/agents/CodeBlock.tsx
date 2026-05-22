/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodeBlock — renders a fenced code block with syntax highlighting via
 *  Monaco's `editor.colorize()` API. Falls back to plain escaped <pre> when
 *  the language is unknown, Monaco hasn't loaded yet, or the colorize call
 *  fails. Monaco's colorize output is trusted HTML (it escapes content), so
 *  dangerouslySetInnerHTML is safe here.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { MonacoLoader } from '../editor/monaco/MonacoLoader.js'
import styles from './agents.module.css'

interface CodeBlockProps {
  readonly code: string
  readonly lang?: string
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (!lang) {
      setHtml(null)
      return
    }
    let cancelled = false
    void MonacoLoader.ensureInitialized()
      .then((monaco) => monaco.editor.colorize(code, lang, { tabSize: 2 }))
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

  return (
    <pre className={styles['codeBlock']} data-lang={lang || 'text'}>
      {html === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
    </pre>
  )
}
