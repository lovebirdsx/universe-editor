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
  GroupDirection,
  IEditorGroupsService,
  IInstantiationService,
  MenuId,
  localize2,
  type IEditorGroup,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { HtmlPreviewInput } from '../services/editor/HtmlPreviewInput.js'
import { openPreviewInGroup, togglePreviewInGroup } from '../services/editor/openPreviewInGroup.js'

const HTML_PRECONDITION = 'activeEditorLanguageId == html'
const HTML_PREVIEW_PRECONDITION = `activeEditorTypeId == '${HtmlPreviewInput.TYPE_ID}'`
// EditorTitle menu `when` is evaluated per group against the group-scoped
// `activeEditorType` key; using the root `activeEditorTypeId` would hide the
// preview's title button whenever another group became active.
const HTML_PREVIEW_MENU_WHEN = `activeEditorType == '${HtmlPreviewInput.TYPE_ID}'`

function openPreview(accessor: ServicesAccessor, toSide: boolean): void {
  const groups = accessor.get(IEditorGroupsService)
  const source = groups.activeGroup
  const active = source.activeEditor
  if (!(active instanceof FileEditorInput)) return

  if (toSide) {
    let target: IEditorGroup =
      groups.findGroup({ direction: GroupDirection.Right }, source) ?? source
    if (target === source) target = groups.addGroup(source, GroupDirection.Right)
    groups.activateGroup(target)
    // The preview inherits the source tab's pin state — a preview-slot source
    // (still in the source group here) yields a slot preview, a pinned one a
    // pinned preview.
    openPreviewInGroup(groups, target, new HtmlPreviewInput(active.resource), {
      pinned: source.isPinned(active) || active.isDirty,
    })
    return
  }

  // Ctrl+Shift+V: replace the source tab with the preview tab in the same group.
  togglePreviewInGroup(groups, source, new HtmlPreviewInput(active), active)
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
  override run(accessor: ServicesAccessor): void {
    openPreview(accessor, false)
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
  override run(accessor: ServicesAccessor): void {
    openPreview(accessor, true)
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
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const group = groups.activeGroup
    const active = group.activeEditor
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
      return
    }

    // Side-by-side or link-opened preview (no held source): activate an already
    // open source tab if present, else open the source file in the preview's slot.
    for (const g of groups.getGroups()) {
      const found = g.editors.find((e) => e.resource?.toString() === sourceUri.toString())
      if (found) {
        groups.activateGroup(g)
        g.setActive(found)
        return
      }
    }
    const source = inst.createInstance(FileEditorInput, sourceUri)
    group.openEditor(source, { activate: true, pinned, index: previewIndex })
    group.closeEditor(active)
  }
}
