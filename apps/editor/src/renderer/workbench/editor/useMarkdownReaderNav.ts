/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMarkdownReaderNav — the shared vimium-style keyboard navigation wiring for
 *  any markdown *reading* surface (the file preview and the built-in doc center).
 *  It owns: the three context keys the navigation Action2s gate on
 *  (markdownPreviewFocused / …FindVisible / …LinkHintsVisible), the link-hints,
 *  scroll/history and find hooks, the `?` help overlay state, and the
 *  IMarkdownPreviewController registered in MarkdownPreviewRegistry (so the
 *  find / link-hint / help commands route to whichever surface holds focus).
 *
 *  Both consumers render the returned `find` / `linkHints` / help state into the
 *  same MarkdownPreviewEditor.module.css overlays. The registry key is the
 *  surface's own resource URI (source file for the preview, universe:/doc/… for
 *  the doc center), so the two never collide.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Emitter, ICommandService, IContextKeyService, type URI } from '@universe-editor/platform'
import {
  MarkdownPreviewRegistry,
  type IMarkdownPreviewController,
} from '../../services/editor/MarkdownPreviewRegistry.js'
import { findMarkdownAnchor } from '../markdown/markdownAnchors.js'
import { collectEntries, lineForPreviewTop, previewTopForLine } from './previewScrollMap.js'
import { useFindInContainer, type FindInContainerState } from './useFindInContainer.js'
import { useMarkdownKeyboardNav } from './useMarkdownKeyboardNav.js'
import { useMarkdownLinkHints, type MarkdownLinkHintsState } from './useMarkdownLinkHints.js'
import { useService } from '../useService.js'

// How long to keep retrying an anchor reveal while late content (mermaid, code
// colorization) grows the document height. Mirrors the preview's restore window.
const ANCHOR_REVEAL_WINDOW_MS = 600

export interface MarkdownReaderNavOptions<T extends HTMLElement> {
  readonly rootRef: MutableRefObject<T | null>
  /** Unique registry key for this surface (source file URI or universe:/doc/… URI). */
  readonly registryUri: URI
  /** Changes whenever the rendered content changes, so find re-scans matches. */
  readonly contentSignature: unknown
  /** True when this surface is the active editor, so it grabs keyboard focus. */
  readonly isActiveEditor: boolean
}

export interface MarkdownReaderNavState {
  readonly find: FindInContainerState
  readonly linkHints: MarkdownLinkHintsState
  readonly helpVisible: boolean
  closeHelp(): void
}

export function useMarkdownReaderNav<T extends HTMLElement>({
  rootRef,
  registryUri,
  contentSignature,
  isActiveEditor,
}: MarkdownReaderNavOptions<T>): MarkdownReaderNavState {
  const contextKeyService = useService(IContextKeyService)
  const commandService = useService(ICommandService)

  // Create the handles without a default value: passing one makes createKey set
  // the key during render, whose onDidChangeContext fire would trigger a setState
  // in menu components while this one is rendering. Initialize in the mount effect.
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
  // Stable handle so the controller (registered keyed on the URI) can toggle help
  // without re-running its effect on every help-state change.
  const toggleHelpRef = useRef(() => setHelpVisible((v) => !v))

  // Vimium-style scroll / history keys. Disabled while link hints own the
  // keyboard so the two never contend; H/L route to the history commands.
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
    contentSignature,
    { hlAll: 'md-find-match', hlCurrent: 'md-find-match-current' },
    (open) => findVisibleKey.set(open),
  )
  // Stable handle for the controller's find methods so registering the controller
  // (keyed on the URI) doesn't churn on every find state change.
  const findRef = useRef(find)
  findRef.current = find

  // Focus the scroll container whenever this surface becomes the active editor,
  // so arrow / vim keys scroll it immediately (the surface is a plain div, not a
  // Monaco instance focusEditorInput() knows how to reach).
  useEffect(() => {
    if (isActiveEditor) rootRef.current?.focus()
  }, [isActiveEditor, rootRef])

  // Register the controller so the find / link-hint / help commands (routed via
  // MarkdownPreviewRegistry.getActive()) reach whichever surface holds focus.
  const keyStr = registryUri.toString()
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onDidScroll = new Emitter<void>()
    const controller: IMarkdownPreviewController = {
      scrollToLine: (line: number) => {
        el.scrollTop = previewTopForLine(collectEntries(el), line)
      },
      scrollToAnchor: (anchor: string) => revealAnchor(el, anchor),
      getTopVisibleLine: () => {
        const entries = collectEntries(el)
        return entries.length === 0 ? undefined : lineForPreviewTop(entries, el.scrollTop)
      },
      isScrolledToBottom: () => el.scrollHeight - el.clientHeight - el.scrollTop <= 2,
      focus: () => el.focus(),
      onDidScroll: onDidScroll.event,
      openFind: () => findRef.current.open(),
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
    // el.focus() fires `focusin` before this listener exists. Reconcile once: if
    // the container already holds focus, mark it active immediately.
    if (el.contains(el.ownerDocument.activeElement)) {
      focusedKey.set(true)
      MarkdownPreviewRegistry.setActive(controller)
    }

    MarkdownPreviewRegistry.register(registryUri, controller)
    return () => {
      el.removeEventListener('scroll', fire)
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
      focusedKey.set(false)
      MarkdownPreviewRegistry.clearActive(controller)
      MarkdownPreviewRegistry.unregister(registryUri, controller)
      onDidScroll.dispose()
    }
    // registryUri is addressed by its string form; keyStr keeps the effect stable
    // across URI instances that stringify equal.
  }, [keyStr, focusedKey, rootRef])

  return { find, linkHints, helpVisible, closeHelp: () => setHelpVisible(false) }
}

function revealAnchor(root: HTMLElement, anchor: string): void {
  const startedAt = Date.now()
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)
  const tryReveal = (): void => {
    const target = findMarkdownAnchor(root, anchor)
    if (target) {
      target.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    if (Date.now() - startedAt < ANCHOR_REVEAL_WINDOW_MS) schedule(tryReveal)
  }
  tryReveal()
}
