/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  History navigation actions: GoBack (Alt+Left), GoForward (Alt+Right), ClearHistory.
 *
 *  GoBack / GoForward consult IHistoryService for the previous / next entry,
 *  open the editor for that resource (reusing an existing tab if possible),
 *  and restore the cursor position via the shared revealSelectionInInput helper.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  EditorInput,
  EditorRegistry,
  IEditorGroupsService,
  IHistoryEntry,
  IHistoryService,
  IInstantiationService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DocEditorInput } from '../services/editor/DocEditorInput.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'
import { openDocInGroup } from '../services/editor/openDoc.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { openMarkdownPreviewInGroup } from '../services/editor/openMarkdownPreview.js'
import { revealSelectionInInput } from '../services/editor/revealEditorPosition.js'

async function navigateTo(accessor: ServicesAccessor, entry: IHistoryEntry): Promise<void> {
  const groups = accessor.get(IEditorGroupsService)
  const inst = accessor.get(IInstantiationService)
  const target = entry.resource.toString()

  let opened: EditorInput | undefined
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor instanceof EditorInput && editor.resource?.toString() === target) {
        groups.activateGroup(group)
        group.setActive(editor)
        opened = editor
        break
      }
    }
    if (opened) break
  }
  if (!opened) {
    // History navigation to an editor no longer in any group opens into the
    // preview slot — matches VSCode and prevents leaving a stale duplicate
    // alongside whatever previously replaced this entry. Non-text editors
    // (Settings, Welcome, ...) rebuild via the registered EditorProvider;
    // fall back to FileEditorInput when typeId is missing or unknown.
    let recreated: EditorInput | null = null
    if (entry.typeId) {
      recreated = EditorRegistry.deserialize(entry.typeId, entry.serialized, accessor)
    }
    const input = recreated ?? inst.createInstance(FileEditorInput, entry.resource)
    if (input instanceof MarkdownPreviewInput) {
      // A preview no longer open: re-create it in place of the current preview
      // tab (matching link-click navigation) so Alt+←/→ walks the trail in one
      // tab instead of piling up a fresh preview each time.
      openMarkdownPreviewInGroup(groups.activeGroup, input, false)
    } else if (input instanceof DocEditorInput) {
      // Same for the built-in guide: reuse the current doc tab so H/L (and
      // Alt+←/→) walk the trail in place instead of opening a new tab.
      openDocInGroup(groups.activeGroup, input, false)
    } else {
      openInLockAwareGroup(groups, input, { activate: true, pinned: false })
    }
    opened = input
  }

  const selection = entry.selection
  if (!selection || !(opened instanceof FileEditorInput)) return

  // Monaco may not be mounted yet (first open) — the shared helper waits for
  // the registry to report the editor, however long the model takes to build.
  // Fire-and-forget: the command completes on navigation; the cursor restore is
  // a continuation of editor mount, not of the command.
  void revealSelectionInInput(opened, {
    startLineNumber: selection.startLine,
    startColumn: selection.startColumn,
  })
}

export class GoBackAction extends Action2 {
  static readonly ID = 'workbench.action.goBack'
  constructor() {
    super({
      id: GoBackAction.ID,
      title: localize2('action.goBack.title', 'Go Back'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'alt+left' },
      precondition: 'canGoBack',
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const history = accessor.get(IHistoryService)
    const entry = history.goBack()
    if (!entry) return
    await navigateTo(accessor, entry)
  }
}

export class GoForwardAction extends Action2 {
  static readonly ID = 'workbench.action.goForward'
  constructor() {
    super({
      id: GoForwardAction.ID,
      title: localize2('action.goForward.title', 'Go Forward'),
      category: localize2('command.category.view', 'View'),
      keybinding: { primary: 'alt+right' },
      precondition: 'canGoForward',
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const history = accessor.get(IHistoryService)
    const entry = history.goForward()
    if (!entry) return
    await navigateTo(accessor, entry)
  }
}

export class ClearHistoryAction extends Action2 {
  static readonly ID = 'workbench.action.clearHistory'
  constructor() {
    super({
      id: ClearHistoryAction.ID,
      title: localize2('action.clearHistory.title', 'Clear Navigation History'),
      category: localize2('command.category.view', 'View'),
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IHistoryService).clear()
  }
}
