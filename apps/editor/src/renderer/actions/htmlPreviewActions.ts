/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HTML preview Action2 definitions — the on-demand HTML preview (our Live
 *  Preview equivalent). .html files open as source text by default; these
 *  commands render them in an iframe.
 *
 *  OpenHtmlPreviewAction (Ctrl+Shift+V):
 *    Replaces the active HTML source tab with the preview tab (VSCode style — no
 *    extra tab). The source FileEditorInput is detached (not disposed) and held
 *    inside the preview so its Monaco model stays alive through the toggle.
 *    The preview inherits the source tab's pin state (a preview-slot source
 *    yields a preview in the slot), and a preview of the same file already open
 *    in another group is focused instead of duplicated — see openPreviewInGroup.
 *
 *  OpenHtmlPreviewToSideAction (Ctrl+K Ctrl+V):
 *    Opens the preview in the right group alongside the source.
 *
 *  OpenHtmlSourceAction:
 *    Preview title-bar button; toggles back to the source tab, re-opening it
 *    with the preview's own pin state.
 *
 *  `Ctrl+Shift+V` is shared with the markdown preview commands; the two never
 *  clash because each is gated on its own active language / editor type
 *  (markdown vs html), which are mutually exclusive.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IInstantiationService,
  MenuId,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { HtmlPreviewInput } from '../services/editor/HtmlPreviewInput.js'
import { openPreviewToSide, togglePreviewInGroup } from '../services/editor/openPreviewInGroup.js'
import { invocationOpenTarget } from '../services/editor/openTarget.js'
import { openSingletonEditor, openTargetServicesFrom } from '../services/editor/openWithTarget.js'
import { IWindowFocusService } from '../services/windows/windowFocusService.js'
import { resolveTargetEditor } from './editorActionHelpers.js'

const HTML_PRECONDITION = 'activeEditorLanguageId == html'
const HTML_PREVIEW_PRECONDITION = `activeEditorTypeId == '${HtmlPreviewInput.TYPE_ID}'`
// EditorTitle menu `when` is evaluated per group against the group-scoped
// `activeEditorType` key; using the root `activeEditorTypeId` would hide the
// preview's title button whenever another group became active.
const HTML_PREVIEW_MENU_WHEN = `activeEditorType == '${HtmlPreviewInput.TYPE_ID}'`

function openPreview(accessor: ServicesAccessor, toSide: boolean, arg?: unknown): void {
  const groups = accessor.get(IEditorGroupsService)
  const windowFocus = accessor.get(IWindowFocusService)
  // A Ctrl/Alt gesture overrides the command's own placement (Alt+click on
  // "Open Preview to the Side" opens a window; Ctrl on "Open Preview" splits).
  const gesture = invocationOpenTarget()
  const placement = gesture !== 'default' ? gesture : toSide ? 'side' : 'default'
  const targets = openTargetServicesFrom(accessor)
  const resolved = resolveTargetEditor(accessor, arg)
  if (!resolved) return
  const source = resolved.group
  const active = resolved.editor
  if (!(active instanceof FileEditorInput)) return

  const openToSide = (): void =>
    openPreviewToSide(groups, source, active, new HtmlPreviewInput(active.resource), windowFocus)
  // Ctrl+Shift+V: replace the source tab with the preview tab in the same group.
  const toggle = (): void =>
    togglePreviewInGroup(groups, source, new HtmlPreviewInput(active), active, windowFocus)

  if (placement === 'newWindow') {
    // The preview is globally unique: an open one is moved, never duplicated.
    void openSingletonEditor(
      targets,
      'newWindow',
      () => new HtmlPreviewInput(active.resource),
      toSide ? openToSide : toggle,
    )
  } else if (placement === 'side') {
    openToSide()
  } else {
    toggle()
  }
}

export class OpenHtmlPreviewAction extends Action2 {
  static readonly ID = 'workbench.action.html.openPreview'
  constructor() {
    super({
      id: OpenHtmlPreviewAction.ID,
      title: localize2('action.html.openPreview.title', 'Open Preview'),
      category: localize2('command.category.html', 'HTML'),
      icon: 'open-preview',
      keybinding: { primary: 'ctrl+shift+v', when: HTML_PRECONDITION },
      precondition: HTML_PRECONDITION,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: HTML_PRECONDITION }],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    openPreview(accessor, false, arg)
  }
}

export class OpenHtmlPreviewToSideAction extends Action2 {
  static readonly ID = 'workbench.action.html.openPreviewToSide'
  constructor() {
    super({
      id: OpenHtmlPreviewToSideAction.ID,
      title: localize2('action.html.openPreviewToSide.title', 'Open Preview to the Side'),
      category: localize2('command.category.html', 'HTML'),
      icon: 'open-preview-side',
      keybinding: { primary: ['ctrl+k', 'ctrl+v'], when: HTML_PRECONDITION },
      precondition: HTML_PRECONDITION,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: HTML_PRECONDITION }],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    openPreview(accessor, true, arg)
  }
}

export class OpenHtmlSourceAction extends Action2 {
  static readonly ID = 'workbench.action.html.showSource'
  constructor() {
    super({
      id: OpenHtmlSourceAction.ID,
      title: localize2('action.html.showSource.title', 'Open Source'),
      category: localize2('command.category.html', 'HTML'),
      icon: 'go-to-file',
      keybinding: { primary: 'ctrl+shift+v', when: HTML_PREVIEW_PRECONDITION },
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: HTML_PREVIEW_MENU_WHEN }],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const windowFocus = accessor.get(IWindowFocusService)
    const resolved = resolveTargetEditor(accessor, arg)
    if (!resolved) return
    const group = resolved.group
    const active = resolved.editor
    if (!(active instanceof HtmlPreviewInput)) return

    const previewIndex = group.indexOf(active)
    const pinned = group.isPinned(active)
    const sourceUri = active.sourceUri
    const sourceInput = active.releaseSource()

    if (sourceInput) {
      // Toggle mode: re-attach the held FileEditorInput at the preview's slot,
      // then close the preview (its dispose() no longer touches the source).
      // A slot preview is replaced in place by the previewReplace branch, so
      // the close below is a no-op.
      group.openEditor(sourceInput, { activate: true, pinned, index: previewIndex })
      group.closeEditor(active)
      if (group !== groups.openTargetGroup) {
        groups.activateGroup(group)
        windowFocus.focusGroup(group)
      }
      return
    }

    // Side-by-side or link-opened preview (no held source): activate an already
    // open source tab if present, else open the source file in the preview's slot.
    // Prefer the clicked group so a same-file tab in another split is not stolen.
    const sourceInGroup = group.editors.find((e) => e.resource?.toString() === sourceUri.toString())
    if (sourceInGroup) {
      group.setActive(sourceInGroup)
      if (group !== groups.openTargetGroup) {
        groups.activateGroup(group)
        windowFocus.focusGroup(group)
      }
      return
    }
    for (const g of groups.getGroups()) {
      if (g === group) continue
      const found = g.editors.find((e) => e.resource?.toString() === sourceUri.toString())
      if (found) {
        groups.activateGroup(g)
        g.setActive(found)
        windowFocus.focusGroup(g)
        return
      }
    }
    const source = inst.createInstance(FileEditorInput, sourceUri)
    group.openEditor(source, { activate: true, pinned, index: previewIndex })
    group.closeEditor(active)
    if (group !== groups.openTargetGroup) {
      groups.activateGroup(group)
      windowFocus.focusGroup(group)
    }
  }
}
