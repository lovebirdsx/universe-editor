/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  DOM-side focus helpers for an editor group's tab strip, kept free of React so
 *  commands (`workbench.action.focusEditorTabs`) can use them without importing
 *  the `useEditorTabsVim` hook module. `useEditorTabsVim` is the other consumer.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup } from '@universe-editor/platform'
import {
  currentWorkbenchDocumentOrUndefined,
  getWorkbenchDocuments,
} from '../../services/windows/workbenchDocuments.js'

export const EDITOR_TAB_BAR_TEST_ID = 'editor-group-tabbar'

export function tabElements(bar: HTMLElement | null): HTMLElement[] {
  if (bar === null) return []
  return [...bar.querySelectorAll<HTMLElement>('[role="tab"]')]
}

/** Locate a group's tab strip across every workbench document (aux windows). */
export function findEditorTabList(groupId: number): HTMLElement | null {
  const docs = [...getWorkbenchDocuments()]
  if (docs.length === 0) {
    const fallback = currentWorkbenchDocumentOrUndefined()
    if (fallback === undefined) return null
    docs.push(fallback)
  }
  for (const doc of docs) {
    const bar = doc.querySelector<HTMLElement>(
      `[data-group-id="${groupId}"] [data-testid="${EDITOR_TAB_BAR_TEST_ID}"]`,
    )
    if (bar !== null) return bar
  }
  return null
}

function focusBarActiveTab(bar: HTMLElement | null): boolean {
  if (bar === null) return false
  const tabs = tabElements(bar)
  if (tabs.length === 0) return false
  const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0] ?? null
  if (active === null) return false
  active.focus()
  return true
}

/** Focus the active tab of `group`; returns false when the group has no tabs. */
export function focusActiveEditorTab(group: IEditorGroup): boolean {
  return focusBarActiveTab(findEditorTabList(group.id))
}

/**
 * Focus the active tab of the active group in the focused window — the
 * DOM-side implementation of `workbench.action.focusEditorTabs`. The attribute
 * lookup keeps the command free of editor-service plumbing (and works for
 * auxiliary windows, whose groups live in their own documents).
 */
export function focusActiveEditorTabs(): boolean {
  const docs = [...getWorkbenchDocuments()]
  const activeDoc = currentWorkbenchDocumentOrUndefined()
  if (activeDoc !== undefined && !docs.includes(activeDoc)) docs.unshift(activeDoc)
  for (const doc of docs) {
    const bar = doc.querySelector<HTMLElement>(
      `[data-group-active="true"] [data-testid="${EDITOR_TAB_BAR_TEST_ID}"]`,
    )
    if (focusBarActiveTab(bar)) return true
  }
  return false
}

/** Strips that already hold the intent, so repeated h/l does not stack listeners. */
const heldTabStrips = new WeakMap<HTMLElement, () => void>()

/**
 * Hold the "activation must not pull focus into Monaco" intent for as long as
 * the strip owns DOM focus. A fixed timer is not enough: the newly activated
 * editor's cached-model swap is scheduled two frames out and may land after it,
 * and its focus pass then reads a cleared flag and steals the keyboard.
 */
export function holdEditorTabsFocus(
  group: IEditorGroup,
  bar: HTMLElement | null = findEditorTabList(group.id),
): void {
  group.preserveFocusOnActivation?.(true)
  if (bar === null) {
    group.preserveFocusOnActivation?.(false)
    return
  }
  if (heldTabStrips.has(bar)) return
  const strip = bar
  const ownerDocument = strip.ownerDocument

  function release(): void {
    if (!heldTabStrips.has(strip)) return
    heldTabStrips.delete(strip)
    strip.removeEventListener('focusout', onFocusOut)
    group.preserveFocusOnActivation?.(false)
  }
  function onFocusOut(event: FocusEvent): void {
    if (event.relatedTarget !== null) {
      if (!strip.contains(event.relatedTarget as Node)) release()
      return
    }
    // relatedTarget is null when the focused tab is removed or the window
    // blurs; activeElement has not settled yet, so re-check after the move.
    queueMicrotask(() => {
      const receiving = ownerDocument.activeElement
      if (receiving !== null && strip.contains(receiving)) return
      release()
    })
  }

  heldTabStrips.set(strip, release)
  strip.addEventListener('focusout', onFocusOut)
}

/**
 * Release the preserve-focus hold for `bar`, whether or not focusout already
 * did so. The hook calls this on unmount: a strip that disappears while it owns
 * the hold must not leave `preserveFocusOnActivation` stuck on.
 */
export function releaseEditorTabsFocus(
  group: IEditorGroup,
  bar: HTMLElement | null = findEditorTabList(group.id),
): void {
  const release = bar === null ? undefined : heldTabStrips.get(bar)
  if (release !== undefined) {
    release()
    return
  }
  group.preserveFocusOnActivation?.(false)
}
