/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only Monaco editor used as the Output-panel content area.
 *  Registers the 'log' language (via MonacoLoader) for level-aware colorization.
 *
 *  Each channel gets its own text model (via IOutputModelService) which is
 *  updated incrementally, so switching channels preserves scroll position and
 *  never re-tokenizes the whole buffer.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { IOutputService, localize, type IDisposable } from '@universe-editor/platform'
import type { monaco } from '../../editor/monaco/MonacoLoader.js'
import { MonacoLoader } from '../../editor/monaco/MonacoLoader.js'
import { IOutputModelService } from '../../../services/output/OutputModelService.js'
import { useObservable, useService } from '../../useService.js'
import { useViewFocusable } from '../../useViewFocusable.js'
import styles from './LogOutputView.module.css'

const BOTTOM_THRESHOLD_PX = 20

export function isScrolledToBottom(editor: monaco.editor.IStandaloneCodeEditor): boolean {
  const scrollTop = editor.getScrollTop()
  const scrollHeight = editor.getScrollHeight()
  const visibleHeight = editor.getLayoutInfo().height
  return scrollTop + visibleHeight >= scrollHeight - BOTTOM_THRESHOLD_PX
}

export function LogOutputView({
  fontSize,
  fontFamily,
  viewId,
}: {
  fontSize: number
  fontFamily: string
  viewId?: string | undefined
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
  const hiddenAreasDisposableRef = useRef<IDisposable | null>(null)
  // Pending one-shot "layout settled, re-reveal the tail" listener; replaced on
  // every fresh model attach and disposed with the editor so it never dangles.
  const settledRevealDisposableRef = useRef<IDisposable | null>(null)

  // The view's keyboard focus target is the Monaco editor itself (VSCode's
  // Output is a full text editor, so arrow keys / selection / Ctrl+C/F/A work
  // the moment the panel is focused). LayoutService.focusView confirms success
  // via `document.activeElement === el`, so the registered element must BE the
  // one that actually takes DOM focus when the editor is focused.
  //
  // With `editContext: true` (monaco 0.55, required so CJK IME composition
  // doesn't bold the active line) that element is the `div.native-edit-context`
  // — FocusTracker and every keydown/keyup/beforeinput listener bind to it. The
  // sibling `textarea.ime-text-area` is a `tabindex=-1` aria-hidden IME
  // placeholder: focusing it leaves Monaco unfocused and the keyboard dead. In
  // the legacy textArea mode the textarea IS the focus target. Until the async
  // editor create resolves the container div stands in; FocusableRegistry hands
  // focus over once the primary starts resolving.
  useViewFocusable(
    viewId,
    useCallback(() => {
      const dom = editorRef.current?.getDomNode()
      return (
        (dom?.querySelector('.native-edit-context') as HTMLElement | null) ??
        (dom?.querySelector('textarea') as HTMLElement | null) ??
        containerRef.current
      )
    }, []),
  )

  // VSCode revealLastLine: park the cursor at the end of the last line and
  // reveal it. The cursor placement doubles as the smart-scroll signal (a
  // cursor on the last line means "following the tail") and as the starting
  // point for keyboard navigation.
  const revealLastLine = useCallback(() => {
    const ed = editorRef.current
    const model = ed?.getModel()
    if (!ed || !model) return
    const lastLine = model.getLineCount()
    const position = { lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) }
    ed.setPosition(position)
    ed.revealPositionInCenterIfOutsideViewport(
      position,
      MonacoLoader.get().editor.ScrollType.Immediate,
    )
  }, [])

  // Keep a live ref so the async init closure reads the latest value
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
          automaticLayout: true,
          scrollBeyondLastLine: false,
          lineNumbers: 'off',
          minimap: { enabled: false },
          wordWrap: 'on',
          glyphMargin: false,
          folding: false,
          renderLineHighlight: 'none',
          ariaLabel: localize('output.editorLabel', 'Output'),
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
      settledRevealDisposableRef.current?.dispose()
      settledRevealDisposableRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
      setEditorReady(false)
    }
    // Intentionally empty: editor is created once per mount; model switching is
    // handled by the effect below.
  }, [])

  // Reclaim focus into Monaco once the editor becomes ready, when focus is
  // parked on this view's own fallback container. focusView() can land DOM
  // focus on the ViewBody fallback (and return "success") before the async
  // editor create resolves the primary getter to `.native-edit-context`; the
  // registry's one-shot handover at registration time then misses, stranding
  // keyboard focus on the container. This is the view-side backstop.
  useEffect(() => {
    if (!editorReady || viewId === undefined) return
    const ed = editorRef.current
    const container = containerRef.current
    if (!ed || !container) return
    const active = document.activeElement as HTMLElement | null
    if (!active) return
    const focusHost =
      (container.querySelector('.native-edit-context') as HTMLElement | null) ??
      (container.querySelector('textarea') as HTMLElement | null)
    if (!focusHost || active === focusHost) return
    // Only steal focus that is parked somewhere inside this view's own
    // `[data-view-id]` subtree (the ViewBody fallback or a stray descendant);
    // never grab focus the user deliberately put elsewhere.
    if (active.closest(`[data-view-id="${viewId}"]`)) {
      ed.focus()
    }
  }, [editorReady, viewId])

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
      revealLastLine()
      // Right after setModel the editor has not laid the new content out yet
      // (scrollHeight still reflects the previous/empty model), so the reveal
      // above can clamp short of the real tail. Re-reveal once the freshly
      // attached model has been laid out; decorations change on layout, so a
      // one-shot listener is the "layout settled" signal available here.
      settledRevealDisposableRef.current?.dispose()
      const d = ed.onDidChangeModelDecorations(() => {
        if (settledRevealDisposableRef.current === d) {
          settledRevealDisposableRef.current = null
        }
        d.dispose()
        if (ed.getModel() === model) revealLastLine()
      })
      settledRevealDisposableRef.current = d
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
      revealLastLine()
    })
    return () => d.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelName, editorReady])

  // Smart scroll: only an explicit cursor move (onDidChangeCursorPosition,
  // reason Explicit) toggles the lock — VSCode outputView parity. There is
  // deliberately NO onDidScrollChange path: Monaco fires that event
  // asynchronously after a programmatic reveal, when the editor sits mid-scroll
  // (scrollHeight already grew, scrollTop not yet at the bottom), so a
  // scroll-based check would misread that transient as the user scrolling away
  // and wrongly release the lock.
  useEffect(() => {
    const ed = editorRef.current
    if (!editorReady || !ed) return
    const Explicit = MonacoLoader.get().editor.CursorChangeReason.Explicit
    const d = ed.onDidChangeCursorPosition((e) => {
      if (e.reason !== Explicit) return
      const model = ed.getModel()
      if (!model) return
      outputModels.setAutoScroll(e.position.lineNumber === model.getLineCount())
    })
    return () => d.dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorReady])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize, fontFamily })
  }, [fontSize, fontFamily])

  return <div ref={containerRef} className={styles['logOutput']} />
}
