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
import { DocEditorInput } from '../services/editor/DocEditorInput.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'
import { MarkdownPreviewRegistry } from '../services/editor/MarkdownPreviewRegistry.js'
import type { IMarkdownPreviewController } from '../services/editor/MarkdownPreviewRegistry.js'

const MARKDOWN_PRECONDITION = 'activeEditorLanguageId == markdown'
// Command precondition gates *executability* against the globally-active editor,
// so it reads the root `activeEditorTypeId` key.
const MARKDOWN_PREVIEW_PRECONDITION = `activeEditorTypeId == '${MarkdownPreviewInput.TYPE_ID}'`
// EditorTitle menu `when` is evaluated per group against the group-scoped
// `activeEditorType` key (set by useEditorGroupScopedContextKey). Using the root
// `activeEditorTypeId` here would hide the preview's title buttons whenever
// another group became active — they must follow the group, not global focus.
const MARKDOWN_PREVIEW_MENU_WHEN = `activeEditorType == '${MarkdownPreviewInput.TYPE_ID}'`
// The find / help buttons work on any markdown *reading* surface — the file
// preview and the built-in doc center both share useMarkdownReaderNav — so their
// title-bar buttons appear on both. (Open Source is preview-only; docs have no
// backing file, so it keeps MARKDOWN_PREVIEW_MENU_WHEN.)
const MARKDOWN_READER_MENU_WHEN = `activeEditorType == '${MarkdownPreviewInput.TYPE_ID}' || activeEditorType == '${DocEditorInput.TYPE_ID}'`

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
      // No `precondition`: it would AND the root `activeEditorTypeId` onto the
      // menu `when`, hiding the button whenever another group is active. Gate the
      // shared `ctrl+shift+v` (vs Open Preview's) on the keybinding `when`
      // instead, where the global active editor is the right scope.
      keybinding: { primary: 'ctrl+shift+v', when: MARKDOWN_PREVIEW_PRECONDITION },
      menu: [{ id: MenuId.EditorTitle, group: 'navigation', when: MARKDOWN_PREVIEW_MENU_WHEN }],
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
//
// `getActive()` tracks the preview holding *keyboard focus*. A keyboard shortcut
// keeps focus inside the preview, so it resolves directly. But clicking a
// title-bar button (Find / Help) moves focus onto the button, firing the
// preview's `focusout` → clearActive(), so by command time getActive() is empty.
// Fall back to the active editor group's preview so the buttons work too.
// ---------------------------------------------------------------------------

function activePreviewController(
  accessor: ServicesAccessor,
): IMarkdownPreviewController | undefined {
  const active = MarkdownPreviewRegistry.getActive()
  if (active) return active
  const editor = accessor.get(IEditorGroupsService).activeGroup.activeEditor
  if (editor instanceof MarkdownPreviewInput) return MarkdownPreviewRegistry.get(editor.sourceUri)
  if (editor instanceof DocEditorInput) return MarkdownPreviewRegistry.get(editor.resource)
  return undefined
}

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
          when: MARKDOWN_READER_MENU_WHEN,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    activePreviewController(accessor)?.openFind()
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
  override run(accessor: ServicesAccessor): void {
    activePreviewController(accessor)?.findNext()
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
  override run(accessor: ServicesAccessor): void {
    activePreviewController(accessor)?.findPrev()
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
  override run(accessor: ServicesAccessor): void {
    activePreviewController(accessor)?.closeFind()
  }
}

// ---------------------------------------------------------------------------
// In-preview link hints (vimium-style). `f` overlays a short label on every
// visible link; typing the label follows it in place. `Shift+F` follows it to
// the side (like Ctrl/Cmd+click). Gated by `markdownPreviewFocused`, and
// suppressed while the find bar or hints are already up so letters aren't stolen.
// ---------------------------------------------------------------------------

const LINK_HINTS_WHEN =
  'markdownPreviewFocused && !markdownPreviewFindVisible && !markdownPreviewLinkHintsVisible'

export class MarkdownPreviewLinkHintsAction extends Action2 {
  static readonly ID = 'workbench.action.markdownPreview.linkHints'
  constructor() {
    super({
      id: MarkdownPreviewLinkHintsAction.ID,
      title: localize2('action.markdownPreview.linkHints.title', 'Show Link Hints'),
      category: FIND_CATEGORY,
      keybinding: { primary: 'f', when: LINK_HINTS_WHEN },
    })
  }
  override run(accessor: ServicesAccessor): void {
    activePreviewController(accessor)?.showLinkHints(false)
  }
}

export class MarkdownPreviewLinkHintsToSideAction extends Action2 {
  static readonly ID = 'workbench.action.markdownPreview.linkHintsToSide'
  constructor() {
    super({
      id: MarkdownPreviewLinkHintsToSideAction.ID,
      title: localize2('action.markdownPreview.linkHintsToSide.title', 'Show Link Hints (to Side)'),
      category: FIND_CATEGORY,
      keybinding: { primary: 'shift+f', when: LINK_HINTS_WHEN },
    })
  }
  override run(accessor: ServicesAccessor): void {
    activePreviewController(accessor)?.showLinkHints(true)
  }
}

export class MarkdownPreviewHelpAction extends Action2 {
  static readonly ID = 'workbench.action.markdownPreview.help'
  constructor() {
    super({
      id: MarkdownPreviewHelpAction.ID,
      title: localize2('action.markdownPreview.help.title', 'Keyboard Shortcuts'),
      category: FIND_CATEGORY,
      icon: 'help',
      // `?` is physically shift+/. The global handler builds the key from
      // `e.key` (already the shifted '?'), but whether the shift modifier is
      // reported varies (real Chromium reports shift+?; Playwright's synthetic
      // press reports a bare ?). Register both so the binding fires either way.
      // The plain `?` is listed last so resolveShortcut (newest-first) shows a
      // clean "?" in the tooltip rather than "Shift+?". Gated like link hints so
      // it never steals the key while the find bar or hints own the keyboard.
      keybinding: [
        { primary: 'shift+?', when: LINK_HINTS_WHEN },
        { primary: '?', when: LINK_HINTS_WHEN },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          group: 'navigation',
          when: MARKDOWN_READER_MENU_WHEN,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    activePreviewController(accessor)?.toggleHelp()
  }
}
