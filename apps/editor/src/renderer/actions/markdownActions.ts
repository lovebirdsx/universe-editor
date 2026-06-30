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
  IInstantiationService,
  MenuId,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'
import { MarkdownPreviewRegistry } from '../services/editor/MarkdownPreviewRegistry.js'

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
      title: localize2('action.markdown.openPreview.title', 'Open Preview'),
      category: localize2('command.category.markdown', 'Markdown'),
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
      title: localize2('action.markdown.openPreviewToSide.title', 'Open Preview to the Side'),
      category: localize2('command.category.markdown', 'Markdown'),
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
      title: localize2('action.markdown.showSource.title', 'Open Source'),
      category: localize2('command.category.markdown', 'Markdown'),
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

    // Side-by-side mode, or a preview opened from a link (no held source):
    // activate an already-open source tab if there is one, else open the source
    // file in place of the preview tab (matching the toggle-back UX).
    const sourceUri = active.sourceUri
    for (const g of groups.getGroups()) {
      const found = g.editors.find((e) => e.resource?.toString() === sourceUri.toString())
      if (found) {
        groups.activateGroup(g)
        g.setActive(found)
        return
      }
    }

    const inst = accessor.get(IInstantiationService)
    const source = inst.createInstance(FileEditorInput, sourceUri)
    group.openEditor(source, { activate: true, pinned: true, index: previewIndex })
    group.closeEditor(active)
  }
}

// ---------------------------------------------------------------------------
// In-preview find (Ctrl+F / F3 / Shift+F3 / Escape). Routed to the focused
// preview via MarkdownPreviewRegistry.getActive(), gated by the
// `markdownPreviewFocused` / `markdownPreviewFindVisible` context keys the
// MarkdownPreviewEditor maintains (mirrors the chat find commands).
// ---------------------------------------------------------------------------

const FIND_CATEGORY = localize2('command.category.markdown', 'Markdown')

export class MarkdownPreviewFindAction extends Action2 {
  static readonly ID = 'workbench.action.markdownPreview.find'
  constructor() {
    super({
      id: MarkdownPreviewFindAction.ID,
      title: localize2('action.markdownPreview.find.title', 'Find in Preview'),
      category: FIND_CATEGORY,
      icon: 'search',
      keybinding: { primary: 'ctrl+f', when: 'markdownPreviewFocused' },
      menu: [
        {
          id: MenuId.EditorTitle,
          group: 'navigation',
          when: MARKDOWN_PREVIEW_PRECONDITION,
        },
      ],
      f1: true,
    })
  }
  override run(): void {
    MarkdownPreviewRegistry.getActive()?.openFind()
  }
}

export class MarkdownPreviewFindNextAction extends Action2 {
  static readonly ID = 'workbench.action.markdownPreview.findNext'
  constructor() {
    super({
      id: MarkdownPreviewFindNextAction.ID,
      title: localize2('action.markdownPreview.findNext.title', 'Find Next'),
      category: FIND_CATEGORY,
      keybinding: { primary: 'f3', when: 'markdownPreviewFindVisible' },
    })
  }
  override run(): void {
    MarkdownPreviewRegistry.getActive()?.findNext()
  }
}

export class MarkdownPreviewFindPreviousAction extends Action2 {
  static readonly ID = 'workbench.action.markdownPreview.findPrevious'
  constructor() {
    super({
      id: MarkdownPreviewFindPreviousAction.ID,
      title: localize2('action.markdownPreview.findPrevious.title', 'Find Previous'),
      category: FIND_CATEGORY,
      keybinding: { primary: 'shift+f3', when: 'markdownPreviewFindVisible' },
    })
  }
  override run(): void {
    MarkdownPreviewRegistry.getActive()?.findPrev()
  }
}

export class MarkdownPreviewFindCloseAction extends Action2 {
  static readonly ID = 'workbench.action.markdownPreview.findClose'
  constructor() {
    super({
      id: MarkdownPreviewFindCloseAction.ID,
      title: localize2('action.markdownPreview.findClose.title', 'Close Find'),
      category: FIND_CATEGORY,
      keybinding: { primary: 'escape', when: 'markdownPreviewFindVisible' },
    })
  }
  override run(): void {
    MarkdownPreviewRegistry.getActive()?.closeFind()
  }
}
