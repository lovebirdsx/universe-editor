/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim adapter for one editor group's tab strip. The strip is a `tabs` surface:
 *  h/l (and the keymap's other surface.next/previous aliases) move the cursor
 *  and activate that editor while keeping DOM focus on the tab, Enter/activate
 *  hands focus to the editor body, x closes, p pins/unpins and the menu key
 *  reuses the tab context menu.
 *
 *  Activation uses `preserveFocus` so EditorGroupView's activation effect does
 *  not pull focus into Monaco behind our back; the tab is focused explicitly
 *  right after.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import {
  IContextKeyService,
  IDialogService,
  type EditorInput,
  type IEditorGroup,
  type IEditorGroupsService,
} from '@universe-editor/platform'
import {
  dispatchKeyboardContextMenu,
  findRowElement,
  useVimSurface,
} from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { closeEditorWithConfirm } from '../../services/editor/closeEditorWithConfirm.js'
import { focusEditorInput, focusGroupBody } from '../../services/editor/editorFocus.js'
import {
  currentWorkbenchDocumentOrUndefined,
  getWorkbenchDocuments,
} from '../../services/windows/workbenchDocuments.js'

const TAB_BAR_TEST_ID = 'editor-group-tabbar'

export function editorTabsSurfaceKey(groupId: number): string {
  return `tabs:${groupId}`
}

function tabElements(bar: HTMLElement | null): HTMLElement[] {
  if (bar === null) return []
  return [...bar.querySelectorAll<HTMLElement>('[role="tab"]')]
}

function focusTabForEditor(bar: HTMLElement | null, editor: EditorInput): boolean {
  if (bar === null) return false
  const tab = findRowElement(bar, 'data-editor-id', editor.id)
  if (tab === null) return false
  tab.focus()
  return true
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
      `[data-group-id="${groupId}"] [data-testid="${TAB_BAR_TEST_ID}"]`,
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
      `[data-group-active="true"] [data-testid="${TAB_BAR_TEST_ID}"]`,
    )
    if (focusBarActiveTab(bar)) return true
  }
  return false
}

/** Strips that already hold the intent, so repeated h/l does not stack listeners. */
const heldTabStrips = new WeakMap<HTMLElement, () => void>()

/**
 * A pending "refocus the tab after closing" retry belongs to one gesture. Any
 * newer h/l / Enter / Escape / close invalidates it so it cannot steal focus
 * back from the destination the user just chose.
 */
let focusRetryGeneration = 0

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

function scheduleFocusActiveTab(group: IEditorGroup, bar: HTMLElement | null): void {
  const generation = ++focusRetryGeneration
  const ownerDocument = bar?.ownerDocument ?? currentWorkbenchDocumentOrUndefined()
  const view = ownerDocument?.defaultView
  if (ownerDocument === undefined || ownerDocument === null || view === undefined || view === null)
    return
  const groupRoot = ownerDocument.querySelector<HTMLElement>(`[data-group-id="${group.id}"]`)

  const focusActive = (): void => {
    const tabs = tabElements(bar)
    const active =
      tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0] ?? null
    active?.focus()
  }
  // The group activation effect focuses Monaco one commit later, after the tab
  // for the new active editor already exists — so refocusing once here can be
  // undone. Retry across a frame while focus is still inside this group (never
  // after the user moved it elsewhere, and never after a newer gesture).
  const attempt = (remaining: number): void => {
    if (generation !== focusRetryGeneration) return
    focusActive()
    if (remaining <= 1) return
    view.requestAnimationFrame(() => {
      if (generation !== focusRetryGeneration) return
      const current = ownerDocument.activeElement
      const onTab = tabElements(bar).some((tab) => tab === current)
      if (onTab) return
      if (current === null || groupRoot?.contains(current) === true) attempt(remaining - 1)
    })
  }
  view.requestAnimationFrame(() => attempt(2))
}

interface TabState {
  readonly group: IEditorGroup
  readonly groupsService: IEditorGroupsService
  readonly dialogService: IDialogService
  readonly contextKeyService: IContextKeyService
  readonly getTabBar: () => HTMLElement | null
}

function activeTabElement(state: TabState): HTMLElement | null {
  const bar = state.getTabBar()
  const editor = state.group.activeEditor
  if (bar === null || editor === undefined) return null
  return findRowElement(bar, 'data-editor-id', editor.id)
}

function activateIndex(state: TabState, index: number, preserveFocus: boolean): void {
  // A new move/activate gesture supersedes a pending refocus from an earlier
  // close (h/l or Enter is about to choose the real focus destination).
  focusRetryGeneration++
  const editors = state.group.editors
  if (editors.length === 0) return
  const target = editors[Math.max(0, Math.min(editors.length - 1, index))]
  if (target === undefined) return
  // Keyboard focus can sit in a non-active group's strip; make this group the
  // command target without stealing editor focus (activation is renderer-side).
  state.groupsService.activateGroup(state.group)
  if (preserveFocus) {
    state.group.setActive(target, { preserveFocus: true })
    focusTabForEditor(state.getTabBar(), target)
    holdEditorTabsFocus(state.group, state.getTabBar())
    return
  }
  state.group.setActive(target)
  focusEditorInput(target, state.contextKeyService, state.group.id)
}

export interface UseEditorTabsVimOptions {
  readonly group: IEditorGroup
  readonly groupsService: IEditorGroupsService
  readonly getTabBar: () => HTMLElement | null
}

export function useEditorTabsVim(options: UseEditorTabsVimOptions): void {
  const dialogService = useService(IDialogService)
  const contextKeyService = useService(IContextKeyService)
  const stateRef = useRef<TabState>({
    group: options.group,
    groupsService: options.groupsService,
    dialogService,
    contextKeyService,
    getTabBar: options.getTabBar,
  })
  stateRef.current = {
    group: options.group,
    groupsService: options.groupsService,
    dialogService,
    contextKeyService,
    getTabBar: options.getTabBar,
  }

  // The hold outlives focusout only while the strip is mounted; unmounting the
  // hook (group teardown) must release it unconditionally.
  const releaseFocusRef = useRef<() => void>(() => undefined)
  releaseFocusRef.current = () => releaseEditorTabsFocus(options.group, options.getTabBar())
  useEffect(
    () => () => {
      focusRetryGeneration++
      releaseFocusRef.current()
    },
    [],
  )

  useVimSurface({
    id: editorTabsSurfaceKey(options.group.id),
    kind: 'tabs',
    focus: 'within',
    getElement: () => stateRef.current.getTabBar(),
    getSurfaceKey: () => editorTabsSurfaceKey(stateRef.current.group.id),
    defaultMode: 'normal',
    actions: {
      move: (direction, count) => {
        const state = stateRef.current
        const active = state.group.activeEditor
        const index = active === undefined ? -1 : state.group.editors.indexOf(active)
        const steps = Math.max(1, count)
        const delta = direction === 'left' || direction === 'up' ? -steps : steps
        activateIndex(state, index < 0 ? 0 : index + delta, true)
      },
      next: (count) => {
        const state = stateRef.current
        const active = state.group.activeEditor
        const index = active === undefined ? -1 : state.group.editors.indexOf(active)
        activateIndex(state, index < 0 ? 0 : index + Math.max(1, count), true)
      },
      previous: (count) => {
        const state = stateRef.current
        const active = state.group.activeEditor
        const index = active === undefined ? -1 : state.group.editors.indexOf(active)
        activateIndex(state, index < 0 ? 0 : index - Math.max(1, count), true)
      },
      first: (count) => {
        activateIndex(stateRef.current, count > 1 ? count - 1 : 0, true)
      },
      last: (count) => {
        const editors = stateRef.current.group.editors
        activateIndex(stateRef.current, count > 1 ? count - 1 : editors.length - 1, true)
      },
      activate: () => {
        const state = stateRef.current
        const editor = state.group.activeEditor
        if (editor === undefined) return
        activateIndex(state, state.group.editors.indexOf(editor), false)
      },
      remove: () => {
        const state = stateRef.current
        const editor = state.group.activeEditor
        if (editor === undefined) return
        // Sticky tabs have no close affordance; x must not close them either.
        if (state.group.isSticky(editor)) return
        const bar = state.getTabBar()
        void closeEditorWithConfirm(editor, state.group, state.dialogService).then((closed) => {
          if (!closed) return
          // Closing auto-activates the neighbouring editor, whose focus effect
          // (and Monaco's deferred focus) would pull the keyboard out of the
          // tab strip. This close came from the strip, so hold focus there;
          // install the hold listener after the refocus pass below has run.
          state.group.preserveFocusOnActivation?.(true)
          scheduleFocusActiveTab(state.group, bar)
          bar?.ownerDocument.defaultView?.requestAnimationFrame(() =>
            holdEditorTabsFocus(state.group, bar),
          )
        })
      },
      toggle: () => {
        const state = stateRef.current
        const editor = state.group.activeEditor
        if (editor === undefined) return
        if (state.group.isSticky(editor)) state.group.unstickEditor(editor)
        else state.group.stickEditor(editor)
      },
      contextMenu: () => {
        const tab = activeTabElement(stateRef.current)
        if (tab !== null) dispatchKeyboardContextMenu(tab, true)
      },
      escape: () => {
        focusRetryGeneration++
        const state = stateRef.current
        const editor = state.group.activeEditor
        if (editor !== undefined) {
          focusEditorInput(editor, state.contextKeyService, state.group.id)
          return
        }
        focusGroupBody(state.contextKeyService, state.group.id)
      },
    },
  })
}
