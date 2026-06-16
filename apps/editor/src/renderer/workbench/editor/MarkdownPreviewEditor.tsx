/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewEditor — renders a MarkdownPreviewInput's source file as
 *  formatted markdown. Tracks the live Monaco model when the source is open
 *  (so edits show immediately) and falls back to reading disk otherwise.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Emitter,
  IEditorGroupsService,
  IEditorInput,
  IFileService,
  URI,
} from '@universe-editor/platform'
import { EditorGroupContext } from './EditorGroupContext.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { MarkdownPreviewRegistry } from '../../services/editor/MarkdownPreviewRegistry.js'
import { MarkdownPreviewViewStateCache } from '../../services/editor/MarkdownPreviewViewStateCache.js'
import { MonacoModelRegistry } from './monaco/MonacoModelRegistry.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { collectEntries, lineForPreviewTop, previewTopForLine } from './previewScrollMap.js'
import { useMarkdownSyncScroll } from './useMarkdownSyncScroll.js'
import { useService } from '../useService.js'
import styles from './MarkdownPreviewEditor.module.css'

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
  const activeGroupActiveEditor = activeGroup.activeEditor
  useMarkdownSyncScroll(rootRef, sourceUri)

  useEffect(() => {
    const model = MonacoModelRegistry.peek(sourceUri)
    if (model) {
      setContent(model.getValue())
      const sub = model.onDidChangeContent(() => setContent(model.getValue()))
      return () => sub.dispose()
    }
    let cancelled = false
    void fileService
      .readFileText(sourceUri)
      .then((text) => {
        if (!cancelled) setContent(text)
      })
      .catch(() => {
        if (!cancelled) setContent('')
      })
    return () => {
      cancelled = true
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

  // The preview is a plain div, not a Monaco instance, so focusEditorInput()
  // (which only knows the editor registries) can't focus it when the group
  // activates it. Focus the scroll container ourselves whenever this preview
  // becomes the active editor, so arrow/page keys scroll it immediately.
  useEffect(() => {
    if (activeGroup !== group) return
    if (activeGroupActiveEditor !== input) return
    rootRef.current?.focus()
  }, [activeGroup, activeGroupActiveEditor, group, input])

  // Expose a controller to the Outline service so clicking a heading scrolls the
  // preview, and so the active heading tracks the viewport. Lives here because
  // the line↔pixel mapping needs the live DOM (data-line blocks settle late).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onDidScroll = new Emitter<void>()
    const controller = {
      scrollToLine: (line: number) => {
        el.scrollTop = previewTopForLine(collectEntries(el), line)
      },
      getTopVisibleLine: () => {
        const entries = collectEntries(el)
        return entries.length === 0 ? undefined : lineForPreviewTop(entries, el.scrollTop)
      },
      focus: () => el.focus(),
      onDidScroll: onDidScroll.event,
    }
    const fire = () => onDidScroll.fire()
    el.addEventListener('scroll', fire, { passive: true })
    MarkdownPreviewRegistry.register(sourceUri, controller)
    return () => {
      el.removeEventListener('scroll', fire)
      MarkdownPreviewRegistry.unregister(sourceUri, controller)
      onDidScroll.dispose()
    }
  }, [sourceUri])

  return (
    <div
      ref={rootRef}
      className={styles['previewRoot']}
      data-testid="markdown-preview"
      tabIndex={0}
    >
      <MarkdownView
        text={content}
        className={styles['previewBody'] ?? ''}
        baseUri={URI.joinPath(sourceUri, '..')}
      />
    </div>
  )
}
