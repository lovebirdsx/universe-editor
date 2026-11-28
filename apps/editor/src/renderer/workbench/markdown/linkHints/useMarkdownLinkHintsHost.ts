/*---------------------------------------------------------------------------------------------
 *  useMarkdownLinkHintsHost — wires any markdown *reading* surface that does not
 *  use `useMarkdownReaderNav` (AI chat, extension README, …) into the shared
 *  link-hints commands: it owns the focus/active registration every surface
 *  needs, publishes the `markdownLinkHintsAvailable` context key the `f` / `F`
 *  Action2s gate on, and delegates `show` / `hide` through
 *  `MarkdownPreviewRegistry.getActive()`.
 *
 *  The container must be the scroll element (or contain the anchors) and must be
 *  focusable, exactly like the preview root: focusin/focusout is what makes the
 *  surface "active" for the global commands. No opening logic lives here — the
 *  hint hook re-dispatches a synthetic click on the anchor, reusing SafeLink.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { Emitter, IContextKeyService, type URI } from '@universe-editor/platform'
import { isElementLike } from '@universe-editor/workbench-ui'
import {
  MarkdownPreviewRegistry,
  type IMarkdownPreviewController,
} from '../../../services/editor/MarkdownPreviewRegistry.js'
import { useService } from '../../useService.js'
import { useMarkdownLinkHints, type MarkdownLinkHintsState } from './useMarkdownLinkHints.js'

// A registered controller must expose `onDidScroll`; a link-hints-only host has
// no outline to feed, so one shared inert emitter keeps the boilerplate tiny.
const NO_OP_SCROLL = new Emitter<void>()

export interface MarkdownLinkHintsHostOptions<T extends HTMLElement> {
  readonly rootRef: MutableRefObject<T | null>
  /** Unique registry key for this surface (session id, extension id, …). */
  readonly registryUri: URI
  /** Changes whenever the rendered content changes (dismisses stale hints). */
  readonly contentSignature?: unknown
}

export interface MarkdownLinkHintsHostState {
  readonly linkHints: MarkdownLinkHintsState
}

export function useMarkdownLinkHintsHost<T extends HTMLElement>({
  rootRef,
  registryUri,
  contentSignature,
}: MarkdownLinkHintsHostOptions<T>): MarkdownLinkHintsHostState {
  const contextKeyService = useService(IContextKeyService)
  // Create without a default: passing one sets the key during render, whose
  // change event can trigger a setState in another component mid-render.
  const availableKey = useMemo(
    () => contextKeyService.createKey<boolean>('markdownLinkHintsAvailable', undefined),
    [contextKeyService],
  )
  // Suppresses the `f` / `F` commands while hints are up so their letters reach
  // the hint filter instead of re-opening (or, for `f`, being consumed twice).
  const visibleKey = useMemo(
    () => contextKeyService.createKey<boolean>('markdownPreviewLinkHintsVisible', undefined),
    [contextKeyService],
  )
  useEffect(() => {
    availableKey.set(false)
    visibleKey.set(false)
  }, [availableKey, visibleKey])

  const linkHints = useMarkdownLinkHints(rootRef, contentSignature)
  const linkHintsRef = useRef(linkHints)
  linkHintsRef.current = linkHints
  useEffect(() => {
    visibleKey.set(linkHints.active)
  }, [linkHints.active, visibleKey])

  const keyStr = registryUri.toString()
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const controller: IMarkdownPreviewController = {
      scrollToLine: () => {},
      scrollToAnchor: () => {},
      getTopVisibleLine: () => undefined,
      isScrolledToBottom: () => false,
      focus: () => el.focus(),
      onDidScroll: NO_OP_SCROLL.event,
      openFind: () => {},
      closeFind: () => {},
      findNext: () => {},
      findPrev: () => {},
      showLinkHints: (inNewTab: boolean) => linkHintsRef.current.show(inNewTab),
      hideLinkHints: () => linkHintsRef.current.hide(),
      toggleHelp: () => {},
    }
    const onFocusIn = () => {
      availableKey.set(true)
      MarkdownPreviewRegistry.setActive(controller)
    }
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget
      if (isElementLike(next) && el.contains(next)) return
      availableKey.set(false)
      MarkdownPreviewRegistry.clearActive(controller)
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)

    // The ref may already hold focus on mount (activation focus runs first), so
    // the focusin listener would miss it. Reconcile once.
    if (el.contains(el.ownerDocument.activeElement)) {
      availableKey.set(true)
      MarkdownPreviewRegistry.setActive(controller)
    }

    MarkdownPreviewRegistry.register(registryUri, controller, {
      ownerDocument: el.ownerDocument,
    })
    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
      availableKey.set(false)
      visibleKey.set(false)
      MarkdownPreviewRegistry.clearActive(controller)
      MarkdownPreviewRegistry.unregister(registryUri, controller)
    }
    // `keyStr` keeps the effect stable across URI instances that stringify equal.
  }, [keyStr, availableKey, visibleKey, rootRef, registryUri])

  return { linkHints }
}
