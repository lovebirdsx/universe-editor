/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only Monaco editor used as the Output-panel content area.
 *  Registers the 'log' language (via MonacoLoader) for level-aware colorization.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import type { monaco } from '../../editor/monaco/MonacoLoader.js'
import { MonacoLoader } from '../../editor/monaco/MonacoLoader.js'
import styles from './LogOutputView.module.css'

function isScrolledToBottom(editor: monaco.editor.IStandaloneCodeEditor): boolean {
  const scrollTop = editor.getScrollTop()
  const scrollHeight = editor.getScrollHeight()
  const visibleHeight = editor.getLayoutInfo().height
  return scrollTop + visibleHeight >= scrollHeight - 20
}

export function LogOutputView({
  content,
  theme,
  fontSize,
  fontFamily,
}: {
  content: string
  theme: 'vs' | 'vs-dark'
  fontSize: number
  fontFamily: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const monacoRef = useRef<typeof monaco | null>(null)
  const prevContentRef = useRef('')

  // Keep a live ref so the async init closure reads the latest value
  const latestContentRef = useRef(content)
  latestContentRef.current = content
  const latestThemeRef = useRef(theme)
  latestThemeRef.current = theme
  const latestFontSizeRef = useRef(fontSize)
  latestFontSizeRef.current = fontSize
  const latestFontFamilyRef = useRef(fontFamily)
  latestFontFamilyRef.current = fontFamily

  // Create the Monaco editor once
  useEffect(() => {
    let disposed = false
    void MonacoLoader.ensureInitialized().then((m) => {
      if (disposed || !containerRef.current) return
      monacoRef.current = m
      const initial = latestContentRef.current
      const model = m.editor.createModel(initial, 'log')
      modelRef.current = model
      prevContentRef.current = initial
      const ed = m.editor.create(
        containerRef.current,
        {
          model,
          readOnly: true,
          editContext: true,
          theme: latestThemeRef.current === 'vs' ? 'output-light' : 'output-dark',
          automaticLayout: true,
          scrollBeyondLastLine: false,
          lineNumbers: 'off',
          minimap: { enabled: false },
          wordWrap: 'on',
          glyphMargin: false,
          folding: false,
          renderLineHighlight: 'none',
          fontSize: latestFontSizeRef.current,
          fontFamily: latestFontFamilyRef.current,
        },
        MonacoLoader.getOverrideServices(),
      )
      editorRef.current = ed
      if (initial) ed.revealLine(model.getLineCount())
    })
    return () => {
      disposed = true
      editorRef.current?.dispose()
      modelRef.current?.dispose()
      editorRef.current = null
      modelRef.current = null
      monacoRef.current = null
      prevContentRef.current = ''
    }
    // Intentionally empty: editor is created once per mount; theme/content
    // changes are handled by their own effects below.
  }, [])

  // Apply content changes incrementally when possible to preserve scroll state
  useEffect(() => {
    const editor = editorRef.current
    const model = modelRef.current
    const m = monacoRef.current
    if (!editor || !model || !m) return
    const prev = prevContentRef.current
    if (content === prev) return
    const atBottom = isScrolledToBottom(editor)
    if (content.startsWith(prev) && content.length > prev.length) {
      const delta = content.slice(prev.length)
      const lc = model.getLineCount()
      const ll = model.getLineContent(lc).length
      model.applyEdits([
        { range: new m.Range(lc, ll + 1, lc, ll + 1), text: delta, forceMoveMarkers: true },
      ])
    } else {
      model.setValue(content)
    }
    prevContentRef.current = content
    if (atBottom || !prev) editor.revealLine(model.getLineCount())
  }, [content])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, fontFamily })
  }, [fontSize, fontFamily])

  return <div ref={containerRef} className={styles['logOutput']} />
}
