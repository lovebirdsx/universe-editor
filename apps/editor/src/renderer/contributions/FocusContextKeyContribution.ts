/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  FocusContextKeyContribution — derives focus-related context keys from the
 *  document's own focus position.
 *
 *  Maintained keys:
 *    focusedPart                — the PartId whose xxxFocus key is true, or ''
 *    focusedView                — viewId currently containing focus, or ''
 *    sideBarFocus               — focus is inside SideBar
 *    secondarySideBarFocus      — focus is inside SecondarySideBar
 *    panelFocus                 — focus is inside Panel
 *    activityBarFocus           — focus is inside ActivityBar
 *    editorAreaFocus            — focus is inside EditorArea
 *    statusBarFocus             — focus is inside StatusBar
 *    terminalFocus              — focus is inside an xterm host, and not a
 *                                 hidden panel terminal (see below)
 *    editorFocus                — a Monaco widget holds DOM focus (derived)
 *    editorTextFocus            — cleared while no Monaco editor holds focus
 *
 *  Everything here is derived from `document.activeElement` on each focus event
 *  (see installDocumentFocusReconcile). It used to be book-kept: the per-part
 *  booleans came from Part.onDidBlur, and the part/view ids from
 *  IFocusTrackerService's settled current element. Both lag or lie.
 *
 *  The tracker is the dangerous one. It debounces through setTimeout(0) and
 *  `_settle` short-circuits when the target equals the element focus is leaving,
 *  so a key can stay on the wrong side of a move. For `editorAreaFocus` a stale
 *  `false` is not cosmetic: Alt+<n> in the session config bar is gated on
 *  `editorAreaFocus && activeEditorTypeId == 'acp.session'`, and so are Ctrl+F /
 *  the resize chords — closing a popover used to leave the whole family dead
 *  until the next unrelated focus move. Part.onDidBlur is the mirror image: it
 *  fires whenever the tracker's tracked subtree loses the settled element, so a
 *  transient blur could clear a key that the DOM still reads as focused.
 *
 *  `Part.onDidFocus` is kept, on purpose, as an *intent* write. Part.focus()
 *  fires it unconditionally, while `container.focus()` is a DOM no-op for the
 *  editor-area / activity-bar / status-bar roots (they carry no tabIndex), so
 *  F6, the bootstrap focus restore and LayoutService's focusPart fallback all
 *  announce focus that the DOM never registers. Only the `true` side is kept:
 *  false is the DOM's to report.
 *
 *  Known boundary: a focus move with no event behind it is invisible here.
 *  Removing the focused node from the DOM is one — Chromium parks `activeElement`
 *  on <body> without dispatching focusout — so a key can stay true until the next
 *  real focus move (the old book-keeping had the same hole; it was event-driven
 *  too). Nothing cheap closes it: the node that goes away is usually deep inside
 *  a Part, so Part.onDidUnmount sees only the whole-Part case.
 *
 *  `focusedView` walks up from the focused element skipping unrelated
 *  `data-testid`s — taking the nearest one made it blind to anything under a view
 *  root, which is what closestPartId documents for the same trap.
 *
 *  `terminalFocus` keeps part of its own shape: startup spawns panel terminals
 *  while the panel is still hidden, and any focus that transiently lands in such
 *  a host must not leave the key stuck true (it would swallow every
 *  `!terminalFocus` keybinding, e.g. Ctrl+P quick open). Panel visibility is part
 *  of the derivation, so it re-syncs on toggle too — a visibility change moves no
 *  DOM focus and therefore emits no focus event.
 *
 *  `editorFocus` / `editorTextFocus` share the same listener mechanics (see
 *  installEditorFocusDerivation) — an embedded Monaco, like the ACP prompt input,
 *  therefore needs no bridge of its own.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Disposable,
  IContextKeyService,
  ILayoutService,
  IWorkbenchContribution,
  PartId,
} from '@universe-editor/platform'
import { installEditorFocusDerivation } from '../services/editor/editorFocus.js'
import { closestAttr } from '../services/focus/FocusStackService.js'
import { installDocumentFocusReconcile } from '../services/focus/documentFocusReconcile.js'

const PART_KEY_BY_ID: Readonly<Record<PartId, string>> = {
  [PartId.ActivityBar]: 'activityBarFocus',
  [PartId.SideBar]: 'sideBarFocus',
  [PartId.SecondarySideBar]: 'secondarySideBarFocus',
  [PartId.EditorArea]: 'editorAreaFocus',
  [PartId.Panel]: 'panelFocus',
  [PartId.StatusBar]: 'statusBarFocus',
}

export class FocusContextKeyContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IContextKeyService contextKeyService: IContextKeyService,
    @ILayoutService layoutService: ILayoutService,
  ) {
    super()

    const focusedPart = contextKeyService.createKey<string>('focusedPart', '')
    const focusedView = contextKeyService.createKey<string>('focusedView', '')
    const terminalFocus = contextKeyService.createKey<boolean>('terminalFocus', false)

    const perPart = new Map<PartId, ReturnType<typeof contextKeyService.createKey<boolean>>>()
    for (const [id, key] of Object.entries(PART_KEY_BY_ID) as [PartId, string][]) {
      perPart.set(id, contextKeyService.createKey<boolean>(key, false))
    }

    const updateTerminalFocus = (active: Element | null): void => {
      const terminalHost = active?.closest('[data-terminal-id]') ?? null
      const hiddenPanelTerminal =
        terminalHost !== null &&
        terminalHost.closest('[data-testid="part-panel"]') !== null &&
        !layoutService.getVisible(PartId.Panel)
      terminalFocus.set(terminalHost !== null && !hiddenPanelTerminal)
    }

    // One DOM read feeds every key. Part.isFocused() is just
    // `container.contains(document.activeElement)`, so nothing here needs a flag
    // that can drift from the DOM — and every key flips in the same task the
    // focus move happened in.
    //
    // `focusedPart` falls out of the same loop rather than resolving the node's
    // nearest Part separately: it is by construction "whichever xxxFocus key is
    // true", so the two can never disagree, and a new PartId only has to be added
    // to PART_KEY_BY_ID (a Record<PartId, …>, so the compiler enforces it).
    const reconcile = (): void => {
      const active = document.activeElement
      let currentPart = ''
      for (const [id, key] of perPart) {
        const focused = layoutService.getPart(id)?.isFocused() ?? false
        key.set(focused)
        if (focused) currentPart = id
      }
      focusedPart.set(currentPart)
      focusedView.set(closestAttr(active, 'data-view-id') ?? '')
      updateTerminalFocus(active)
    }

    // Parts register after this contribution (blockStartup.ts orders us before
    // WorkbenchPartsContribution), so getParts() is empty on construction and the
    // initial reconcile lands on nothing — bind on registration to seed each key.
    const bindPart = (partId: PartId): void => {
      const part = layoutService.getPart(partId)
      if (!part) return
      this._register(part.onDidFocus(() => perPart.get(partId)?.set(true)))
      reconcile()
    }
    for (const part of layoutService.getParts()) bindPart(part.id)
    this._register(layoutService.onDidRegisterPart((p) => bindPart(p.id)))

    // Panel toggles don't move DOM focus by themselves fast enough to rely on
    // focus events alone (the pass-focus handoff is best-effort), so re-derive on
    // visibility changes too.
    this._register(
      autorun((r) => {
        layoutService.visible.read(r)
        updateTerminalFocus(document.activeElement)
      }),
    )

    this._register(installDocumentFocusReconcile(reconcile))
    this._register(installEditorFocusDerivation(contextKeyService))
    reconcile()
  }
}
