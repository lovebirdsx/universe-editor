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
  ICommandService,
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
import { useMarkdownLinkHints } from './useMarkdownLinkHints.js'
import { useMarkdownKeyboardNav } from './useMarkdownKeyboardNav.js'
import { MarkdownPreviewHelp } from './MarkdownPreviewHelp.js'
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
  const commandService = useService(ICommandService)
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

  // Create the handles without a default value: passing one makes createKey set
  // the key during render, and the resulting onDidChangeContext fire triggers a
  // setState in menu components (useMenuItems' useSyncExternalStore) while this
  // one is rendering — React's "setState while rendering another component"
  // warning. Initialize to false in the mount effect below instead.
  const findVisibleKey = useMemo(
    () => contextKeyService.createKey<boolean>('markdownPreviewFindVisible', undefined),
    [contextKeyService],
  )
  const focusedKey = useMemo(
    () => contextKeyService.createKey<boolean>('markdownPreviewFocused', undefined),
    [contextKeyService],
  )
  const linkHintsVisibleKey = useMemo(
    () => contextKeyService.createKey<boolean>('markdownPreviewLinkHintsVisible', undefined),
    [contextKeyService],
  )
  useEffect(() => {
    findVisibleKey.set(false)
    focusedKey.set(false)
    linkHintsVisibleKey.set(false)
  }, [findVisibleKey, focusedKey, linkHintsVisibleKey])

  const linkHints = useMarkdownLinkHints(rootRef)
  const linkHintsRef = useRef(linkHints)
  linkHintsRef.current = linkHints
  useEffect(() => {
    linkHintsVisibleKey.set(linkHints.active)
  }, [linkHints.active, linkHintsVisibleKey])

  const [helpVisible, setHelpVisible] = useState(false)
  // Stable handle so the controller (registered keyed on sourceUri) can toggle
  // help without re-running its effect on every help-state change. The `?` key
  // reaches this via the MarkdownPreviewHelpAction keybinding → controller.
  const toggleHelpRef = useRef(() => setHelpVisible((v) => !v))
  // Vimium-style scroll / history keys. Disabled while link hints own the
  // keyboard so the two never contend; H/L route to the existing history commands.
  useMarkdownKeyboardNav(
    rootRef,
    {
      goBack: () => void commandService.executeCommand('workbench.action.goBack'),
      goForward: () => void commandService.executeCommand('workbench.action.goForward'),
    },
    !linkHints.active,
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
      // Closing returns keyboard focus to the scroll container so f / Ctrl+F /
      // vim keys keep working without a click. Esc routes here via the global
      // MarkdownPreviewFindClose command (the find input's own Esc is shadowed
      // by the capture-phase keybinding handler), so the focus restore must live
      // on the controller, not only on the widget's onClose. Mirrors ChatBody.
      closeFind: () => {
        findRef.current.close()
        el.focus({ preventScroll: true })
      },
      findNext: () => findRef.current.next(),
      findPrev: () => findRef.current.prev(),
      showLinkHints: (inNewTab: boolean) => linkHintsRef.current.show(inNewTab),
      hideLinkHints: () => linkHintsRef.current.hide(),
      toggleHelp: () => toggleHelpRef.current(),
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

    // The auto-focus effect above runs before this one on mount, so its
    // el.focus() fires `focusin` before this listener exists — leaving
    // markdownPreviewFocused false until the user clicks. Reconcile once now: if
    // the container already holds focus, mark it active immediately.
    if (el.contains(el.ownerDocument.activeElement)) {
      focusedKey.set(true)
      MarkdownPreviewRegistry.setActive(controller)
    }

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
            rootRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
      <MarkdownView
        text={content}
        className={styles['previewBody'] ?? ''}
        baseUri={URI.joinPath(sourceUri, '..')}
        previewLinks
      />
      {linkHints.active && (
        <div className={styles['linkHintsLayer']} data-find-widget aria-hidden="true">
          {linkHints.markers.map((m, i) => (
            <span
              key={i}
              className={styles['linkHint']}
              style={{ left: `${m.left}px`, top: `${m.top}px` }}
              data-testid="md-link-hint"
              data-link-label={m.label}
            >
              {m.label.split('').map((ch, j) => (
                <span
                  key={j}
                  className={j < linkHints.typed.length ? styles['linkHintTyped'] : undefined}
                >
                  {ch}
                </span>
              ))}
            </span>
          ))}
        </div>
      )}
      {helpVisible && <MarkdownPreviewHelp onClose={() => setHelpVisible(false)} />}
    </div>
  )
}
