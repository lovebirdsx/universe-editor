/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Markdown preview Action2 definitions.
 *
 *  OpenMarkdownPreviewAction (Ctrl+Shift+V):
 *    Replaces the active markdown source tab with the preview tab (VSCode style —
 *    no extra tab is created). The source FileEditorInput is detached (not
 *    disposed) and held inside the preview so its Monaco model stays alive.
 *
 *  OpenMarkdownSourceAction:
 *    Appears in the preview tab's title bar. Replaces the preview tab back with
 *    the original source tab (toggle back). The held FileEditorInput is re-added
 *    to the group before the preview is closed, so dirty content is preserved.
 *
 *  OpenMarkdownPreviewToSideAction (Ctrl+K Ctrl+V):
 *    Opens preview in the right group alongside the source (unchanged).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  GroupDirection,
  IEditorGroupsService,
  type IEditorGroup,
  MenuId,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'

const MARKDOWN_PRECONDITION = 'activeEditorLanguageId == markdown'
const MARKDOWN_PREVIEW_PRECONDITION = `activeEditorTypeId == '${MarkdownPreviewInput.TYPE_ID}'`

function openPreview(accessor: ServicesAccessor, toSide: boolean): void {
  const groups = accessor.get(IEditorGroupsService)
  const source = groups.activeGroup
  const active = source.activeEditor
  if (!(active instanceof FileEditorInput)) return

  let target: IEditorGroup = source
  if (toSide) {
    target = groups.findGroup({ direction: GroupDirection.Right }, source) ?? source
    if (target === source) target = groups.addGroup(source, GroupDirection.Right)
    groups.activateGroup(target)
    target.openEditor(new MarkdownPreviewInput(active.resource), { activate: true, pinned: true })
    return
  }

  // Ctrl+Shift+V: replace the source tab with the preview tab in the same group.
  const input = new MarkdownPreviewInput(active)
  const existing = target.findEditor(input)
  if (existing) {
    // Preview already open in this group — just activate it.
    target.setActive(existing)
    return
  }
  const sourceIndex = target.indexOf(active)
  // Insert preview at source's position, then detach source (without disposing
  // it) so the held Monaco model survives until the user switches back.
  target.openEditor(input, { activate: true, pinned: true, index: sourceIndex })
  target.detachEditor(active)
  // detachEditor cut `active` from the group store without disposing it; the
  // preview now owns its lifecycle.
  input.adoptSource()
}

export class OpenMarkdownPreviewAction extends Action2 {
  static readonly ID = 'workbench.action.markdown.openPreview'
  constructor() {
    super({
      id: OpenMarkdownPreviewAction.ID,
      title: localize('action.markdown.openPreview.title', 'Open Preview'),
      category: localize('command.category.markdown', 'Markdown'),
      icon: 'open-preview',
      keybinding: { primary: 'ctrl+shift+v' },
      precondition: MARKDOWN_PRECONDITION,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: MARKDOWN_PRECONDITION }],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    openPreview(accessor, false)
  }
}

export class OpenMarkdownPreviewToSideAction extends Action2 {
  static readonly ID = 'workbench.action.markdown.openPreviewToSide'
  constructor() {
    super({
      id: OpenMarkdownPreviewToSideAction.ID,
      title: localize('action.markdown.openPreviewToSide.title', 'Open Preview to the Side'),
      category: localize('command.category.markdown', 'Markdown'),
      icon: 'open-preview-side',
      keybinding: { primary: ['ctrl+k', 'ctrl+v'] },
      precondition: MARKDOWN_PRECONDITION,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: MARKDOWN_PRECONDITION }],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    openPreview(accessor, true)
  }
}

export class OpenMarkdownSourceAction extends Action2 {
  static readonly ID = 'workbench.action.markdown.showSource'
  constructor() {
    super({
      id: OpenMarkdownSourceAction.ID,
      title: localize('action.markdown.showSource.title', 'Open Source'),
      category: localize('command.category.markdown', 'Markdown'),
      icon: 'go-to-file',
      keybinding: { primary: 'ctrl+shift+v' },
      precondition: MARKDOWN_PREVIEW_PRECONDITION,
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: MARKDOWN_PREVIEW_PRECONDITION }],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const groups = accessor.get(IEditorGroupsService)
    const group = groups.activeGroup
    const active = group.activeEditor
    if (!(active instanceof MarkdownPreviewInput)) return

    const previewIndex = group.indexOf(active)
    const sourceInput = active.releaseSource()

    if (sourceInput) {
      // Toggle mode: re-attach the held FileEditorInput at the preview's position,
      // then close the preview. The preview's dispose() is a no-op for the source
      // since releaseSource() cleared _sourceInput.
      group.openEditor(sourceInput, { activate: true, pinned: true, index: previewIndex })
      group.closeEditor(active)
      return
    }

    // Side-by-side mode: the source is in another group. Search all groups and
    // activate it; fall back to opening from the source URI.
    const sourceUri = active.sourceUri
    for (const g of groups.getGroups()) {
      const found = g.editors.find((e) => e.resource?.toString() === sourceUri.toString())
      if (found) {
        groups.activateGroup(g)
        g.setActive(found)
        return
      }
    }
  }
}
