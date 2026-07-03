/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared doc-center opening logic so clicking a link in a built-in guide and
 *  back/forward navigation behave identically. Plain navigation replaces the
 *  current doc tab in place (so the trail stays a single tab, mirroring the
 *  markdown preview); `toSide` opens an additional doc tab in the group.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup } from '@universe-editor/platform'
import { DocEditorInput } from './DocEditorInput.js'

/**
 * Open {@link doc} in {@link group}. When the active editor is another doc and
 * `toSide` is false, the new doc takes its tab slot and the old one is closed —
 * so navigating between linked docs reuses one tab and H/L (or Alt+←/→) walks
 * the trail without piling up tabs. `openEditor` dedups by id, so a target
 * already open in the group is reused and activated instead.
 */
export function openDocInGroup(group: IEditorGroup, doc: DocEditorInput, toSide: boolean): void {
  if (!toSide) {
    const current = group.activeEditor
    if (current instanceof DocEditorInput && current.id !== doc.id) {
      const index = group.indexOf(current)
      group.openEditor(doc, { activate: true, pinned: true, index })
      group.closeEditor(current)
      return
    }
  }
  group.openEditor(doc, { activate: true, pinned: true })
}
