/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Opens an editor into the lock-aware target group (see
 *  IEditorGroupsService.activeGroupForOpen). When the active group is locked the
 *  open is routed to another (unlocked) group, which is then activated so the
 *  editor is what the user sees. Returns the instance that actually owns the tab
 *  — the group dedupes by identity and disposes the caller's fresh duplicate, so
 *  callers that reveal/focus afterwards must use the return value.
 *--------------------------------------------------------------------------------------------*/

import type {
  EditorInput,
  IEditorGroup,
  IEditorGroupsService,
  IOpenEditorOptions,
} from '@universe-editor/platform'

export function openInLockAwareGroup(
  groups: IEditorGroupsService,
  editor: EditorInput,
  options?: IOpenEditorOptions,
  preferredGroup?: IEditorGroup,
): EditorInput {
  // A caller that names its owning group (e.g. an editor-title button on a
  // non-active split) opens there unless that group is locked.
  const target =
    preferredGroup !== undefined && !preferredGroup.isLocked
      ? preferredGroup
      : // Fall back to openTargetGroup for minimal test doubles that predate the
        // lock-aware getter; production always provides activeGroupForOpen.
        (groups.activeGroupForOpen ?? groups.openTargetGroup)
  target.openEditor(editor, options)
  if (target !== groups.openTargetGroup && options?.activate !== false) {
    groups.activateGroup(target)
  }
  // The target group may already own the same identity; findEditor matches by
  // id even after dedupe disposed the duplicate. Minimal test doubles predate
  // findEditor (same as the activeGroupForOpen fallback above).
  return target.findEditor?.(editor) ?? editor
}
