/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Opens a fresh editor into the lock-aware target group (see
 *  IEditorGroupsService.activeGroupForOpen). When the active group is locked the
 *  open is routed to another (unlocked) group, which is then activated so the
 *  editor is what the user sees. Call sites that reveal an already-open editor
 *  should keep using activeGroup directly.
 *--------------------------------------------------------------------------------------------*/

import type {
  EditorInput,
  IEditorGroupsService,
  IOpenEditorOptions,
} from '@universe-editor/platform'

export function openInLockAwareGroup(
  groups: IEditorGroupsService,
  editor: EditorInput,
  options?: IOpenEditorOptions,
): void {
  // Fall back to activeGroup for minimal test doubles that predate the
  // lock-aware getter; production always provides activeGroupForOpen.
  const target = groups.activeGroupForOpen ?? groups.activeGroup
  target.openEditor(editor, options)
  if (target !== groups.activeGroup && options?.activate !== false) {
    groups.activateGroup(target)
  }
}
