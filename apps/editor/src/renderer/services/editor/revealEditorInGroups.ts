/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reveal an already-open singleton editor, wherever it lives.
 *
 *  IEditorService.openEditor only dedupes within the *active* group, which is
 *  correct for files (the same file may legitimately be open in two split
 *  groups) but wrong for singleton editors like Git Graph or AI Settings: with
 *  one already open in another group, running its command opened a second copy
 *  in the active group. Call this first and only construct a fresh input when
 *  it returns false.
 *--------------------------------------------------------------------------------------------*/

import type { EditorInput, IEditorGroupsService } from '@universe-editor/platform'

/**
 * Activate the first editor matching `predicate` across all groups, preferring
 * the active group so a duplicate elsewhere doesn't yank the user out of the
 * group they are working in. Returns false when no group holds a match.
 */
export function revealEditorInGroups(
  groups: IEditorGroupsService,
  predicate: (editor: EditorInput) => boolean,
): boolean {
  const active = groups.activeGroup
  const ordered = [active, ...groups.groups.filter((g) => g !== active)]
  for (const group of ordered) {
    const editor = group.editors.find(predicate)
    if (!editor) continue
    groups.activateGroup(group)
    group.setActive(editor)
    return true
  }
  return false
}
