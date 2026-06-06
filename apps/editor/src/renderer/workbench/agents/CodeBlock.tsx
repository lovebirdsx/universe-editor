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
import { resolveLanguageId } from '../editor/monaco/languageId.js'
import styles from './agents.module.css'

interface CodeBlockProps {
  readonly code: string
  readonly lang?: string
  readonly line?: number
}

export function CodeBlock({ code, lang, line }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null)

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

  return (
    <pre
      className={styles['codeBlock']}
      data-lang={lang || 'text'}
      {...(line !== undefined ? { 'data-line': line } : {})}
    >
      {html === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
    </pre>
  )
}
