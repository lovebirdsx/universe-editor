/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only Monaco editor used as the Output-panel content area.
 *  Registers the 'log' language (via MonacoLoader) for level-aware colorization.
 *
 *  Each channel gets its own text model (via IOutputModelService) which is
 *  updated incrementally, so switching channels preserves scroll position and
 *  never re-tokenizes the whole buffer.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { IOutputService, type IDisposable } from '@universe-editor/platform'
import type { monaco } from '../../editor/monaco/MonacoLoader.js'
import { MonacoLoader } from '../../editor/monaco/MonacoLoader.js'
import { IOutputModelService } from '../../../services/output/OutputModelService.js'
import { useObservable, useService } from '../../useService.js'
import styles from './LogOutputView.module.css'

const BOTTOM_THRESHOLD_PX = 20

export function isScrolledToBottom(editor: monaco.editor.IStandaloneCodeEditor): boolean {
  const scrollTop = editor.getScrollTop()
  const scrollHeight = editor.getScrollHeight()
  const visibleHeight = editor.getLayoutInfo().height
  return scrollTop + visibleHeight >= scrollHeight - BOTTOM_THRESHOLD_PX
}

export function LogOutputView({
  theme,
  fontSize,
  fontFamily,
}: {
  theme: 'vs' | 'vs-dark'
  fontSize: number
  fontFamily: string
}) {
  const outputService = useService(IOutputService)
  const outputModels = useService(IOutputModelService)
  const activeChannelName = useObservable(outputService.activeChannelName)
  const autoScroll = useObservable(outputModels.autoScroll)

  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const autoScrollRef = useRef(autoScroll)
  autoScrollRef.current = autoScroll
  // Set around programmatic reveals so the scroll listener below doesn't read
  // them as a user scrolling away from the tail.
  const applyingRevealRef = useRef(false)
  const hiddenAreasDisposableRef = useRef<IDisposable | null>(null)

  // Keep a live ref so the async init closure reads the latest value
  const latestThemeRef = useRef(theme)
  latestThemeRef.current = theme
  const latestFontSizeRef = useRef(fontSize)
  latestFontSizeRef.current = fontSize
  const latestFontFamilyRef = useRef(fontFamily)
  latestFontFamilyRef.current = fontFamily

  // Create the Monaco editor once
  useEffect(() => {
    let disposed = false
    let hoverGuard: IDisposable | undefined
    void MonacoLoader.ensureInitialized().then((m) => {
      if (disposed || !containerRef.current) return
      const ed = m.editor.create(
        containerRef.current,
        {
          model: null,
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
          // Logs routinely contain CJK / full-width punctuation; never flag
          // them as ambiguous or pop the "ambiguous unicode characters" banner.
          unicodeHighlight: {
            ambiguousCharacters: false,
            invisibleCharacters: false,
            nonBasicASCII: false,
          },
          fontSize: latestFontSizeRef.current,
          fontFamily: latestFontFamilyRef.current,
        },
        MonacoLoader.getOverrideServices(),
      )
      editorRef.current = ed
      hoverGuard = MonacoLoader.trackEditorDispose(ed)
      setEditorReady(true)
    })
    return () => {
      disposed = true
      hoverGuard?.dispose()
      hiddenAreasDisposableRef.current?.dispose()
      hiddenAreasDisposableRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
      setEditorReady(false)
    }
    // Intentionally empty: editor is created once per mount; model switching is
    // handled by the effect below.
  }, [])

  // Switch models when the active channel changes; save/restore per-channel
  // view state so scroll position survives the round-trip.
  useEffect(() => {
    if (!editorReady) return
    const name = activeChannelName
    return () => {
      // Re-read the ref: on unmount the editor is already disposed.
      const ed = editorRef.current
      if (name && ed) outputModels.saveViewState(name, ed.saveViewState())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelName, editorReady])

  useEffect(() => {
    const ed = editorRef.current
    if (!editorReady || !ed) return
    if (!activeChannelName) {
      ed.setModel(null)
      return
    }
    const channel = outputService.getChannel(activeChannelName)
    if (!channel) {
      ed.setModel(null)
      return
    }
    const model = outputModels.acquireModel(channel)
    ed.setModel(model)
    // Re-apply level/text filters to the freshly attached model (a no-op when
    // the editor lacks setHiddenAreas or no filter is active).
    hiddenAreasDisposableRef.current?.dispose()
    hiddenAreasDisposableRef.current = outputModels.attachHiddenAreas(activeChannelName, ed) ?? null
    const saved = outputModels.getViewState(activeChannelName)
    if (saved) {
      ed.restoreViewState(saved)
    } else {
      applyingRevealRef.current = true
      ed.revealLine(model.getLineCount())
      applyingRevealRef.current = false
    }
    // The restored position decides whether we follow the tail from here.
    outputModels.setAutoScroll(isScrolledToBottom(ed))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelName, editorReady])

  // Follow the tail while autoScroll is on.
  useEffect(() => {
    const ed = editorRef.current
    if (!editorReady || !ed) return
    const model = ed.getModel()
    if (!model) return
    const d = model.onDidChangeContent(() => {
      if (!autoScrollRef.current) return
      applyingRevealRef.current = true
      ed.revealLine(model.getLineCount())
      applyingRevealRef.current = false
    })
    return () => d.dispose()
  }, [activeChannelName, editorReady])

  // Smart scroll: a user scroll away from the tail locks auto-scroll; scrolling
  // back to the bottom unlocks it again.
  useEffect(() => {
    const ed = editorRef.current
    if (!editorReady || !ed) return
    const d = ed.onDidScrollChange(() => {
      if (applyingRevealRef.current) return
      outputModels.setAutoScroll(isScrolledToBottom(ed))
    })
    return () => d.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorReady])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, fontFamily })
  }, [fontSize, fontFamily])

  return <div ref={containerRef} className={styles['logOutput']} />
}
