/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewEditor — renders a MarkdownPreviewInput's source file as
 *  formatted markdown. Tracks the live Monaco model when the source is open
 *  (so edits show immediately) and falls back to reading disk otherwise.
 *
 *  The vimium-style keyboard navigation (link hints / scroll / find / help) is
 *  shared with the doc center via useMarkdownReaderNav; this component keeps only
 *  what's preview-specific: Monaco model binding, scroll persistence and the
 *  source↔preview sync scroll.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IEditorGroupsService, IEditorInput, IFileService, URI } from '@universe-editor/platform'
import { EditorGroupContext } from './EditorGroupContext.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { MarkdownPreviewViewStateCache } from '../../services/editor/MarkdownPreviewViewStateCache.js'
import { MonacoModelRegistry } from './monaco/MonacoModelRegistry.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { useMarkdownSyncScroll } from './useMarkdownSyncScroll.js'
import { useMarkdownReaderNav } from './useMarkdownReaderNav.js'
import { MarkdownPreviewHelp } from './MarkdownPreviewHelp.js'
import { MarkdownReaderOverlays } from './MarkdownReaderOverlays.js'
import { useService } from '../useService.js'
import styles from './MarkdownPreviewEditor.module.css'
import './markdownFindHighlight.css'

// How long to keep re-applying the restored scrollTop as content settles
// (mermaid renders serially, Monaco colorizes code fences late — both grow the
// document height after mount, clamping a one-shot restore against a too-short
// scrollHeight). Mirrors ChatBody's restore window.
const RESTORE_WINDOW_MS = 600

export function MarkdownPreviewEditor({ input }: { input: IEditorInput }) {
  const fileService = useService(IFileService)
  const groupsService = useService(IEditorGroupsService)
  const group = useContext(EditorGroupContext)
  const sourceUri = (input as MarkdownPreviewInput).sourceUri
  const stateKey = sourceUri.toString()
  const [content, setContent] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  // True while re-applying a restored scrollTop, so onScroll doesn't treat the
  // programmatic scroll as a user action and overwrite the saved target.
  const restoringRef = useRef(false)
  const activeGroup = groupsService.activeGroup
  const isActiveEditor = activeGroup === group && activeGroup.activeEditor === input
  useMarkdownSyncScroll(rootRef, sourceUri)

  const { find, linkHints, helpVisible, closeHelp } = useMarkdownReaderNav({
    rootRef,
    registryUri: sourceUri,
    contentSignature: content,
    isActiveEditor,
  })

  // Bind to the source's shared Monaco model so edits show live. When the source
  // file isn't open in any editor (e.g. a preview reached by clicking a link),
  // there is no shared model — so the Outline view and the markdown language
  // service, which both read symbols from that model, would find nothing. Create
  // (acquire) the model from disk for the preview's lifetime and release it on
  // unmount, so those consumers see the document just like an open source file.
  useEffect(() => {
    let released = false
    let acquired = false
    let sub: { dispose(): void } | undefined

    const bind = (model: ReturnType<typeof MonacoModelRegistry.peek>): void => {
      if (!model || released) return
      setContent(model.getValue())
      sub = model.onDidChangeContent(() => setContent(model.getValue()))
    }

    const existing = MonacoModelRegistry.peek(sourceUri)
    if (existing) {
      bind(existing)
    } else {
      void fileService
        .readFileText(sourceUri)
        .then((text) => {
          if (released) return
          // Another consumer may have opened the source meanwhile; acquire dedups.
          acquired = true
          bind(MonacoModelRegistry.acquire(sourceUri, text))
        })
        .catch(() => {
          if (!released) setContent('')
        })
    }

    return () => {
      released = true
      sub?.dispose()
      if (acquired) MonacoModelRegistry.release(sourceUri)
    }
  }, [fileService, sourceUri])

  // Persist scroll position on every scroll so a tab switch (which unmounts this
  // component) keeps it. Read the live DOM only while connected — a detached node
  // reports scrollTop 0, which would clobber the saved value on unmount.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onScroll = () => {
      if (restoringRef.current) return
      MarkdownPreviewViewStateCache.save(stateKey, { scrollTop: el.scrollTop })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [stateKey])

  // Restore the saved scroll position on (re)mount. Content height grows
  // asynchronously, so re-apply across a short window via ResizeObserver until it
  // settles or the user takes over.
  useLayoutEffect(() => {
    const el = rootRef.current
    const saved = MarkdownPreviewViewStateCache.load(stateKey)
    if (!el || !saved || saved.scrollTop <= 0) return
    const target = saved.scrollTop
    restoringRef.current = true

    const apply = () => {
      if (!restoringRef.current) return
      if (el.scrollTop !== target) el.scrollTop = target
    }
    apply()

    const ro = new ResizeObserver(apply)
    ro.observe(el)
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)

    const timerRef: { id?: ReturnType<typeof setTimeout> } = {}
    const stop = () => {
      if (!restoringRef.current) return
      restoringRef.current = false
      ro.disconnect()
      if (timerRef.id !== undefined) clearTimeout(timerRef.id)
      el.removeEventListener('wheel', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('keydown', stop)
    }
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('pointerdown', stop)
    el.addEventListener('keydown', stop)
    timerRef.id = setTimeout(stop, RESTORE_WINDOW_MS)
    return stop
  }, [stateKey])

  return (
    <div
      ref={rootRef}
      className={styles['previewRoot']}
      data-testid="markdown-preview"
      tabIndex={0}
    >
      <MarkdownReaderOverlays find={find} linkHints={linkHints} rootRef={rootRef} />
      <MarkdownView
        text={content}
        className={styles['previewBody'] ?? ''}
        baseUri={URI.joinPath(sourceUri, '..')}
        previewLinks
      />
      {helpVisible && <MarkdownPreviewHelp onClose={closeHelp} />}
    </div>
  )
}
