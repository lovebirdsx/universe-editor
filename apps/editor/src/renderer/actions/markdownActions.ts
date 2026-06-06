/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Markdown preview Action2 definitions: open a rendered preview in the current
 *  group or to the side. Visibility is gated to markdown files via
 *  `activeEditorLanguageId == markdown`.
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

function openPreview(accessor: ServicesAccessor, toSide: boolean): void {
  const groups = accessor.get(IEditorGroupsService)
  const source = groups.activeGroup
  const active = source.activeEditor
  if (!(active instanceof FileEditorInput)) return

  const input = new MarkdownPreviewInput(active.resource)
  let target: IEditorGroup = source
  if (toSide) {
    target = groups.findGroup({ direction: GroupDirection.Right }, source) ?? source
    if (target === source) target = groups.addGroup(source, GroupDirection.Right)
  }
  groups.activateGroup(target)
  target.openEditor(input, { activate: true, pinned: true })
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
