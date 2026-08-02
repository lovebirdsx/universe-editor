/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared markdown-preview opening logic so clicking a link in a preview and
 *  back/forward navigation behave identically. Plain navigation replaces the
 *  current preview tab in place (so the trail stays a single tab, VSCode-style);
 *  `toSide` opens an additional preview tab in the group.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup } from '@universe-editor/platform'
import { MarkdownPreviewInput } from './MarkdownPreviewInput.js'

/**
 * Open {@link preview} in {@link group}. When the active editor is another
 * markdown preview and `toSide` is false, the new preview takes its tab slot and
 * the old one is closed — so navigating between linked previews reuses one tab
 * and Alt+←/→ walks the trail without piling up tabs. `openEditor` dedups by id,
 * so a target already open in the group is reused and activated instead.
 */
export function openMarkdownPreviewInGroup(
  group: IEditorGroup,
  preview: MarkdownPreviewInput,
  toSide: boolean,
): void {
  if (!toSide) {
    const current = group.activeEditor
    if (current instanceof MarkdownPreviewInput && current.id !== preview.id) {
      const index = group.indexOf(current)
      group.openEditor(preview, { activate: true, pinned: true, index })
      // A toggle-mode preview holds its source FileEditorInput; closing it
      // would cascade-dispose the source and release the shared Monaco model,
      // silently dropping unsaved edits. Re-attach a dirty source as a tab
      // next to the new preview before closing the old one (a clean source
      // loses nothing and keeps the single-tab behavior).
      if (current.isDirty) {
        const held = current.releaseSource()
        if (held) group.openEditor(held, { activate: false, pinned: true, index: index + 1 })
      }
      group.closeEditor(current)
      return
    }
  }
  group.openEditor(preview, { activate: true, pinned: true })
}
