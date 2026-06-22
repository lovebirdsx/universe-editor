/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewEditor — renders a MarkdownPreviewInput's source file as
 *  formatted markdown. Tracks the live Monaco model when the source is open
 *  (so edits show immediately) and falls back to reading disk otherwise.
 *--------------------------------------------------------------------------------------------*/

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Emitter,
  IContextKeyService,
  IEditorGroupsService,
  IEditorInput,
  IFileService,
  URI,
} from '@universe-editor/platform'
import { EditorGroupContext } from './EditorGroupContext.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import {
  MarkdownPreviewRegistry,
  type IMarkdownPreviewController,
} from '../../services/editor/MarkdownPreviewRegistry.js'
import { MarkdownPreviewViewStateCache } from '../../services/editor/MarkdownPreviewViewStateCache.js'
import { MonacoModelRegistry } from './monaco/MonacoModelRegistry.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { collectEntries, lineForPreviewTop, previewTopForLine } from './previewScrollMap.js'
import { useMarkdownSyncScroll } from './useMarkdownSyncScroll.js'
import { useFindInContainer } from './useFindInContainer.js'
import { ChatFindWidget } from '../agents/ChatFindWidget.js'
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
  const contextKeyService = useService(IContextKeyService)
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

  const findVisibleKey = useMemo(
    () => contextKeyService.createKey<boolean>('markdownPreviewFindVisible', false),
    [contextKeyService],
  )
  const focusedKey = useMemo(
    () => contextKeyService.createKey<boolean>('markdownPreviewFocused', false),
    [contextKeyService],
  )

  const find = useFindInContainer(
    rootRef,
    content,
    { hlAll: 'md-find-match', hlCurrent: 'md-find-match-current' },
    (open) => findVisibleKey.set(open),
  )
  // Stable handle for the controller's find methods so registering the controller
  // (keyed on sourceUri) doesn't churn on every find state change.
  const findRef = useRef(find)
  findRef.current = find

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
  // The controller also routes find commands (Ctrl+F / F3 / Escape): the find
  // methods read through findRef so this effect needn't re-run on find state.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onDidScroll = new Emitter<void>()
    const controller: IMarkdownPreviewController = {
      scrollToLine: (line: number) => {
        el.scrollTop = previewTopForLine(collectEntries(el), line)
      },
      getTopVisibleLine: () => {
        const entries = collectEntries(el)
        return entries.length === 0 ? undefined : lineForPreviewTop(entries, el.scrollTop)
      },
      focus: () => el.focus(),
      onDidScroll: onDidScroll.event,
      openFind: () => findRef.current.open(),
      closeFind: () => findRef.current.close(),
      findNext: () => findRef.current.next(),
      findPrev: () => findRef.current.prev(),
    }
    const fire = () => onDidScroll.fire()
    el.addEventListener('scroll', fire, { passive: true })

    // Track focus so find commands target the preview the user is looking at and
    // the `markdownPreviewFocused` / `markdownPreviewFindVisible` keys gate them.
    const onFocusIn = () => {
      focusedKey.set(true)
      MarkdownPreviewRegistry.setActive(controller)
    }
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget
      if (next instanceof Node && el.contains(next)) return
      focusedKey.set(false)
      MarkdownPreviewRegistry.clearActive(controller)
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)

    MarkdownPreviewRegistry.register(sourceUri, controller)
    return () => {
      el.removeEventListener('scroll', fire)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
      focusedKey.set(false)
      MarkdownPreviewRegistry.clearActive(controller)
      MarkdownPreviewRegistry.unregister(sourceUri, controller)
      onDidScroll.dispose()
    }
  }, [sourceUri, focusedKey])

  return (
    <div
      ref={rootRef}
      className={styles['previewRoot']}
      data-testid="markdown-preview"
      tabIndex={0}
    >
      {find.visible && (
        <ChatFindWidget
          className={styles['findWidget']}
          query={find.query}
          count={find.count}
          currentIndex={find.currentIndex}
          onQueryChange={find.setQuery}
          onNext={find.next}
          onPrev={find.prev}
          onClose={() => {
            find.close()
            rootRef.current?.focus()
          }}
        />
      )}
      <MarkdownView
        text={content}
        className={styles['previewBody'] ?? ''}
        baseUri={URI.joinPath(sourceUri, '..')}
      />
    </div>
  )
}
